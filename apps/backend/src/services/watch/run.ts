/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-base-to-string -- SPIKE code */
/**
 * SPIKE (spike/watch-tracking-load): one run of the Watch tracking cron
 * (ADR 0003). Claims the due reads, reads Stremio, queues the Destination
 * writes of new watched titles, sweeps the Accounts of the current slots,
 * then sends the due writes (Simkl through the global gate).
 */
import type { ProviderId } from "@stremlist/shared/providers";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../../lib/concurrency";
import { decryptSecret } from "../../lib/crypto";
import { supabase } from "../../lib/supabase";
import type { Account } from "../accounts";
import { resolveAccountKey } from "../accounts";
import { performAction } from "../actions";
import type { LibraryItem } from "./library";
import {
  datastoreGet,
  datastoreMeta,
  libraryStats,
  mtimeOf,
  seriesVideos,
  watchedBits,
} from "./library";
import type { Plan, ReadRow, StartState } from "./schedule";
import {
  alreadyWatched,
  nextWriteRetry,
  planAfterFailure,
  planAfterRead,
  startStateOf,
} from "./schedule";
import type { WatchState } from "./state";
import { readState, updateState } from "./state";

const READ_BATCH = Number(process.env.WATCH_READ_BATCH ?? 250);
const READ_CONCURRENCY = Number(process.env.WATCH_READ_CONCURRENCY ?? 40);
const SWEEP_CONCURRENCY = Number(process.env.WATCH_SWEEP_CONCURRENCY ?? 20);
const WRITE_CONCURRENCY = Number(process.env.WATCH_WRITE_CONCURRENCY ?? 20);
const SIMKL_RATE = Number(process.env.WATCH_SIMKL_RATE ?? 1);
/** The reads stop taking new batches after this, so the run ends in time. */
const READ_BUDGET_MS = 35_000;
const RUN_BUDGET_MS = 55_000;
/** Save a sweep's checkedAt at least this often, even with no new watch. */
const STATE_REFRESH_MS = 24 * 3600_000;

interface Target {
  imdbId: string;
  type: "movie" | "series";
  episode?: { season: number; episode: number };
  watchedAt: string;
}

function newStats() {
  return {
    startedAt: new Date().toISOString(),
    readsClaimed: 0,
    readsOk: 0,
    readsFailed: 0,
    readBatches: 0,
    staleFinish: 0,
    detections: 0,
    detectionsDuplicate: 0,
    stops: {} as Record<string, number>,
    phases: {} as Record<string, number>,
    oldestDueLagMs: 0,
    dueLagMs: [] as number[],
    sweepSlots: 0,
    sweepAccounts: 0,
    sweepBaselines: 0,
    sweepChangedItems: 0,
    sweepGets: 0,
    sweepDetections: 0,
    sweepStateWrites: 0,
    sweepFailed: 0,
    writesQueued: 0,
    writesOk: {} as Record<string, number>,
    writesFailed: {} as Record<string, number>,
    writesGivenUp: 0,
    simklGranted: 0,
    simklUsed: 0,
    stateReads: 0,
    stateWrites: 0,
    phaseMs: {} as Record<string, number>,
    stremio: {
      get: 0,
      meta: 0,
      failed: 0,
      retries: 0,
      p50: 0,
      p95: 0,
      metaBytes: 0,
      cinemeta: 0,
    },
    errors: [] as string[],
  };
}
export type RunStats = ReturnType<typeof newStats>;

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function noteError(stats: RunStats, error: unknown): void {
  if (stats.errors.length < 10)
    stats.errors.push(
      error instanceof Error
        ? error.message
        : typeof error === "object"
          ? JSON.stringify(error).slice(0, 300)
          : String(error),
    );
}

interface ClaimedRead {
  account_id: string;
  item_id: string;
  item_type: "movie" | "series";
  video_id: string;
  due_at: string;
  generation: number;
  phase: string;
  cycle_started_at: string;
  expected_flip_at: string | null;
  expected_end_at: string | null;
  start_state: StartState;
  last_time_watched: number | null;
  last_moved_at: string | null;
  reads: number;
  failures: number;
  auth_key: string | null;
}

const time = (value: string | null) => (value ? Date.parse(value) : null);
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();

function toRow(claimed: ClaimedRead): ReadRow {
  return {
    itemType: claimed.item_type,
    videoId: claimed.video_id,
    phase: claimed.phase,
    cycleStartedAt: Date.parse(claimed.cycle_started_at),
    expectedFlipAt: time(claimed.expected_flip_at),
    expectedEndAt: time(claimed.expected_end_at),
    startState: claimed.start_state ?? {},
    lastTimeWatched: claimed.last_time_watched,
    lastMovedAt: time(claimed.last_moved_at),
    reads: claimed.reads,
    failures: claimed.failures,
  };
}

/** The Destination targets of new watched titles. */
async function targetsOf(
  item: LibraryItem,
  itemType: "movie" | "series",
  newBits: number[] | null,
): Promise<Target[]> {
  const watchedAt =
    item.state?.lastWatched ??
    new Date(mtimeOf(item) || Date.now()).toISOString();
  if (itemType === "movie" || !newBits)
    return [{ imdbId: item._id, type: itemType, watchedAt }];
  const videos = await seriesVideos(item._id);
  return newBits.flatMap((bit) =>
    videos[bit]
      ? [
          {
            imdbId: item._id,
            type: "series" as const,
            episode: videos[bit],
            watchedAt,
          },
        ]
      : [],
  );
}

function stateWith(
  state: WatchState | null,
  item: LibraryItem,
  itemType: "movie" | "series",
): WatchState | false {
  const next: WatchState = state
    ? { ...state, movies: [...state.movies], series: { ...state.series } }
    : { checkedAt: 0, savedAt: 0, movies: [], series: {} };
  if (itemType === "movie") {
    if (next.movies.includes(item._id)) return false;
    next.movies.push(item._id);
  } else {
    const field = item.state?.watched ?? "";
    if (next.series[item._id] === field) return false;
    next.series[item._id] = field;
  }
  next.savedAt = Date.now();
  return next;
}

/**
 * Records a detection in the Account's R2 state, then returns the writes to
 * queue. A title already in the state (the sweep or another run sent it)
 * gives none.
 */
async function recordDetection(
  stats: RunStats,
  accountId: string,
  destinations: string[],
  item: LibraryItem,
  itemType: "movie" | "series",
  newBits: number[] | null,
): Promise<Record<string, unknown>[]> {
  stats.stateReads += 1;
  const current = await readState(accountId);
  let bits = newBits;
  if (itemType === "series" && current.state && newBits) {
    // Only the bits that the state does not have yet.
    const known = watchedBits(current.state.series[item._id]);
    bits = newBits.filter((bit) => !known.has(bit));
    if (bits.length === 0) {
      stats.detectionsDuplicate += 1;
      return [];
    }
  }
  const saved = await updateState(
    accountId,
    (state) => stateWith(state, item, itemType),
    current,
  );
  if (!saved) {
    stats.detectionsDuplicate += 1;
    return [];
  }
  stats.stateWrites += 1;
  const targets = await targetsOf(item, itemType, bits);
  return targets.flatMap((target) =>
    destinations.map((provider) => ({
      account_id: accountId,
      provider,
      imdb_id: target.imdbId,
      item_type: target.type,
      season: target.episode?.season ?? null,
      episode: target.episode?.episode ?? null,
      watched_at: target.watchedAt,
    })),
  );
}

async function queueWrites(
  stats: RunStats,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("watch_writes" as never)
    .insert(rows as never);
  if (error) throw error;
  stats.writesQueued += rows.length;
}

const destinationsCache = new Map<string, string[]>();
async function destinationsOf(accountIds: string[]): Promise<void> {
  const missing = accountIds.filter((id) => !destinationsCache.has(id));
  if (missing.length === 0) return;
  for (let i = 0; i < missing.length; i += 200) {
    const { data, error } = await supabase
      .from("watch_tracking" as never)
      .select("account_id, destinations")
      .in("account_id", missing.slice(i, i + 200));
    if (error) throw error;
    for (const row of (data ?? []) as {
      account_id: string;
      destinations: string[];
    }[])
      destinationsCache.set(row.account_id, row.destinations);
  }
}

async function processReads(stats: RunStats, deadline: number): Promise<void> {
  const lease = randomUUID();
  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc(
      "claim_watch_reads" as never,
      {
        p_limit: READ_BATCH,
        p_lease_seconds: 120,
        p_lease_token: lease,
      } as never,
    );
    if (error) throw error;
    const claimed = (data ?? []) as ClaimedRead[];
    stats.readBatches += 1;
    stats.readsClaimed += claimed.length;
    if (claimed.length === 0) break;
    const now0 = Date.now();
    for (const row of claimed) {
      const lag = now0 - Date.parse(row.due_at);
      stats.dueLagMs.push(lag);
      stats.oldestDueLagMs = Math.max(stats.oldestDueLagMs, lag);
    }
    await destinationsOf([...new Set(claimed.map((row) => row.account_id))]);
    const writes: Record<string, unknown>[] = [];
    const finished = await mapWithConcurrency(
      claimed,
      READ_CONCURRENCY,
      async (claimedRow) => {
        const row = toRow(claimedRow);
        let plan: Plan;
        try {
          if (!claimedRow.auth_key) throw new Error("no Stremio link");
          const authKey = decryptSecret(claimedRow.auth_key);
          const [item] = await datastoreGet(authKey, [claimedRow.item_id]);
          plan = planAfterRead(row, item, Date.now());
          stats.readsOk += 1;
          if (plan.detected && item) {
            stats.detections += 1;
            const bits = "bits" in plan.detected ? plan.detected.bits : null;
            writes.push(
              ...(await recordDetection(
                stats,
                claimedRow.account_id,
                destinationsCache.get(claimedRow.account_id) ?? [],
                item,
                claimedRow.item_type,
                bits,
              )),
            );
          }
        } catch (error) {
          stats.readsFailed += 1;
          noteError(stats, error);
          plan = planAfterFailure(row, Date.now());
        }
        if (plan.next === null) bump(stats.stops, plan.stopReason ?? "stop");
        else bump(stats.phases, plan.row.phase);
        return {
          account_id: claimedRow.account_id,
          item_id: claimedRow.item_id,
          generation: claimedRow.generation,
          next_due_at: iso(plan.next),
          phase: plan.row.phase,
          expected_flip_at: iso(plan.row.expectedFlipAt),
          expected_end_at: iso(plan.row.expectedEndAt),
          last_time_watched: plan.row.lastTimeWatched,
          last_moved_at: iso(plan.row.lastMovedAt),
          reads: plan.row.reads,
          failures: plan.row.failures,
        };
      },
    );
    await queueWrites(stats, writes);
    const { data: changed, error: finishError } = await supabase.rpc(
      "finish_watch_reads" as never,
      { p_lease_token: lease, p_rows: finished } as never,
    );
    if (finishError) throw finishError;
    stats.staleFinish += finished.length - Number(changed ?? 0);
    if (claimed.length < READ_BATCH) break;
  }
}

/** One Account of the 6-hour sweep. */
async function sweepAccount(
  stats: RunStats,
  account: { account_id: string; destinations: string[]; auth_key: string },
): Promise<void> {
  const authKey = decryptSecret(account.auth_key);
  stats.stateReads += 1;
  const current = await readState(account.account_id);
  const meta = await datastoreMeta(authKey);
  if (!current.state) {
    // Watched baseline: never sent.
    stats.sweepBaselines += 1;
    const items: LibraryItem[] = [];
    for (let i = 0; i < meta.length; i += 100) {
      stats.sweepGets += 1;
      items.push(
        ...(await datastoreGet(
          authKey,
          meta.slice(i, i + 100).map(([id]) => id),
          "sweep",
        )),
      );
    }
    const state: WatchState = {
      checkedAt: 0,
      savedAt: Date.now(),
      movies: [],
      series: {},
    };
    for (const item of items) {
      state.checkedAt = Math.max(state.checkedAt, mtimeOf(item));
      if (item.type === "movie" && (item.state?.timesWatched ?? 0) > 0)
        state.movies.push(item._id);
      if (item.type === "series" && item.state?.watched)
        state.series[item._id] = item.state.watched;
    }
    await updateState(account.account_id, () => state, current);
    stats.stateWrites += 1;
    return;
  }
  const previous = current.state;
  const changed = meta.filter(([, mtime]) => mtime > previous.checkedAt);
  stats.sweepChangedItems += changed.length;
  if (changed.length === 0) return;
  const items: LibraryItem[] = [];
  for (let i = 0; i < changed.length; i += 100) {
    stats.sweepGets += 1;
    items.push(
      ...(await datastoreGet(
        authKey,
        changed.slice(i, i + 100).map(([id]) => id),
        "sweep",
      )),
    );
  }
  const movies = new Set(previous.movies);
  const found: {
    item: LibraryItem;
    type: "movie" | "series";
    bits: number[] | null;
  }[] = [];
  for (const item of items) {
    if (item.type === "movie") {
      if ((item.state?.timesWatched ?? 0) > 0 && !movies.has(item._id))
        found.push({ item, type: "movie", bits: null });
    } else if (item.type === "series" && item.state?.watched) {
      const before = watchedBits(previous.series[item._id]);
      const fresh = [...watchedBits(item.state.watched)].filter(
        (bit) => !before.has(bit),
      );
      if (fresh.length > 0) found.push({ item, type: "series", bits: fresh });
    }
  }
  const newest = Math.max(
    previous.checkedAt,
    ...changed.map(([, mtime]) => mtime),
  );
  if (found.length === 0 && Date.now() - previous.savedAt < STATE_REFRESH_MS)
    return;
  stats.sweepDetections += found.length;
  // The state first, so a trigger run that reads it meanwhile skips these.
  const saved = await updateState(
    account.account_id,
    (state) => {
      const base = state ?? previous;
      const next: WatchState = {
        checkedAt: Math.max(base.checkedAt, newest),
        savedAt: Date.now(),
        movies: [...base.movies],
        series: { ...base.series },
      };
      for (const { item, type } of found) {
        if (type === "movie") {
          if (!next.movies.includes(item._id)) next.movies.push(item._id);
        } else next.series[item._id] = item.state?.watched ?? "";
      }
      return next;
    },
    current,
  );
  if (saved) stats.sweepStateWrites += 1;
  const writes: Record<string, unknown>[] = [];
  for (const { item, type, bits } of found) {
    for (const target of await targetsOf(item, type, bits)) {
      for (const provider of account.destinations) {
        writes.push({
          account_id: account.account_id,
          provider,
          imdb_id: target.imdbId,
          item_type: target.type,
          season: target.episode?.season ?? null,
          episode: target.episode?.episode ?? null,
          watched_at: target.watchedAt,
        });
      }
    }
  }
  await queueWrites(stats, writes);
}

async function processSweep(stats: RunStats): Promise<void> {
  const { data: slots, error } = await supabase.rpc(
    "claim_sweep_slots" as never,
    {
      p_now: new Date().toISOString(),
    } as never,
  );
  if (error) throw error;
  const slotList = ((slots ?? []) as { slot: number }[]).map((row) => row.slot);
  stats.sweepSlots = slotList.length;
  if (slotList.length === 0) return;
  const { data, error: accountsError } = await supabase.rpc(
    "watch_sweep_accounts" as never,
    { p_slots: slotList } as never,
  );
  if (accountsError) throw accountsError;
  const accounts = (data ?? []) as {
    account_id: string;
    destinations: string[];
    auth_key: string;
  }[];
  stats.sweepAccounts = accounts.length;
  await mapWithConcurrency(accounts, SWEEP_CONCURRENCY, async (account) => {
    try {
      await sweepAccount(stats, account);
    } catch (error) {
      stats.sweepFailed += 1;
      noteError(stats, error);
    }
  });
}

interface ClaimedWrite {
  id: number;
  account_id: string;
  provider: string;
  imdb_id: string;
  item_type: "movie" | "series";
  season: number | null;
  episode: number | null;
  attempts: number;
  first_failed_at: string | null;
}

const accountCache = new Map<string, Account>();
async function accountOf(id: string): Promise<Account | null> {
  const cached = accountCache.get(id);
  if (cached) return cached;
  const access = await resolveAccountKey(id);
  if (!access) return null;
  if (accountCache.size > 5000) accountCache.clear();
  accountCache.set(id, access.account);
  return access.account;
}

async function sendWrite(
  stats: RunStats,
  write: ClaimedWrite,
): Promise<{
  id: number;
  done: boolean;
  next_due_at: string | null;
  error: string | null;
}> {
  const fail = (error: string) => {
    bump(stats.writesFailed, write.provider);
    const now = Date.now();
    const next = nextWriteRetry(
      write.attempts,
      write.first_failed_at ? Date.parse(write.first_failed_at) : now,
      now,
    );
    if (next === null) stats.writesGivenUp += 1;
    return { id: write.id, done: false, next_due_at: iso(next), error };
  };
  try {
    const account = await accountOf(write.account_id);
    if (!account)
      return {
        id: write.id,
        done: true,
        next_due_at: null,
        error: "no account",
      };
    const [outcome] = await performAction(
      account,
      [write.provider as ProviderId],
      { kind: "watched", add: true },
      {
        imdbId: write.imdb_id,
        type: write.item_type,
        ...(write.season !== null && write.episode !== null
          ? { episode: { season: write.season, episode: write.episode } }
          : {}),
      },
    );
    if (!outcome?.ok) return fail(outcome?.error ?? "failed");
    bump(stats.writesOk, write.provider);
    return { id: write.id, done: true, next_due_at: null, error: null };
  } catch (error) {
    noteError(stats, error);
    return fail(error instanceof Error ? error.message : "error");
  }
}

async function claimWrites(
  provider: string,
  exclude: boolean,
  limit: number,
  lease: string,
): Promise<ClaimedWrite[]> {
  if (limit <= 0) return [];
  const { data, error } = await supabase.rpc(
    "claim_watch_writes" as never,
    {
      p_provider: provider,
      p_exclude: exclude,
      p_limit: limit,
      p_lease_seconds: 90,
      p_lease_token: lease,
    } as never,
  );
  if (error) throw error;
  return (data ?? []) as ClaimedWrite[];
}

async function finishWrites(lease: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.rpc(
    "finish_watch_writes" as never,
    {
      p_lease_token: lease,
      p_rows: rows,
    } as never,
  );
  if (error) throw error;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function processWrites(
  stats: RunStats,
  runStarted: number,
): Promise<void> {
  const lease = randomUUID();
  // Trakt and MDBList: at once.
  const others = await claimWrites("simkl", true, 500, lease);
  const results = await mapWithConcurrency(others, WRITE_CONCURRENCY, (write) =>
    sendWrite(stats, write),
  );
  await finishWrites(lease, results);

  // Simkl: the global gate spaces the POSTs 1/rate apart.
  const window = (runStarted + RUN_BUDGET_MS - Date.now()) / 1000 - 3;
  if (window <= 1) return;
  const { data: gate, error } = await supabase.rpc(
    "take_simkl_slots" as never,
    {
      p_want: Math.ceil(window * SIMKL_RATE),
      p_rate: SIMKL_RATE,
      p_window_seconds: window,
    } as never,
  );
  if (error) throw error;
  const { granted, first_slot_at } = (
    (gate ?? []) as { granted: number; first_slot_at: string }[]
  )[0] ?? {
    granted: 0,
    first_slot_at: new Date().toISOString(),
  };
  stats.simklGranted = granted;
  const simkl = await claimWrites("simkl", false, granted, lease);
  stats.simklUsed = simkl.length;
  if (granted > simkl.length) {
    await supabase.rpc(
      "return_simkl_slots" as never,
      {
        p_unused: granted - simkl.length,
        p_rate: SIMKL_RATE,
      } as never,
    );
  }
  const first = Date.parse(first_slot_at);
  const simklResults = await Promise.all(
    simkl.map(async (write, index) => {
      await sleep(
        Math.max(0, first + (index * 1000) / SIMKL_RATE - Date.now()),
      );
      return sendWrite(stats, write);
    }),
  );
  await finishWrites(lease, simklResults);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))],
  );
}

export async function runWatchCron(): Promise<RunStats> {
  const stats = newStats();
  const started = Date.now();
  libraryStats.get = 0;
  libraryStats.meta = 0;
  libraryStats.failed = 0;
  libraryStats.retries = 0;
  libraryStats.latencies = [];
  libraryStats.metaBytes = 0;
  libraryStats.cinemeta = 0;
  const phase = async (name: string, task: () => Promise<void>) => {
    const at = Date.now();
    try {
      await task();
    } catch (error) {
      noteError(stats, error);
    }
    stats.phaseMs[name] = Date.now() - at;
  };
  await phase("reads", () => processReads(stats, started + READ_BUDGET_MS));
  await phase("sweep", () => processSweep(stats));
  await phase("writes", () => processWrites(stats, started));
  stats.phaseMs.total = Date.now() - started;
  stats.stremio = {
    get: libraryStats.get,
    meta: libraryStats.meta,
    failed: libraryStats.failed,
    retries: libraryStats.retries,
    p50: percentile(libraryStats.latencies, 0.5),
    p95: percentile(libraryStats.latencies, 0.95),
    metaBytes: libraryStats.metaBytes,
    cinemeta: libraryStats.cinemeta,
  };
  const lags = stats.dueLagMs;
  (stats as unknown as Record<string, unknown>).dueLag = {
    p50: percentile(lags, 0.5),
    p95: percentile(lags, 0.95),
    max: percentile(lags, 1),
  };
  stats.dueLagMs = [];
  return stats;
}

/**
 * A /stream request of a tracked Account: read the item once at once, then
 * start its cycle. Never throws.
 */
export async function startCycle(
  accountId: string,
  authKeySealed: string,
  type: "movie" | "series",
  videoId: string,
): Promise<string> {
  const itemId = videoId.split(":")[0];
  const authKey = decryptSecret(authKeySealed);
  const [item] = await datastoreGet(authKey, [itemId]);
  let targetBit: number | null = null;
  if (type === "series") {
    const [, season, episode] = videoId.split(":").map(Number);
    const videos = await seriesVideos(itemId);
    const index = videos.findIndex(
      (v) => v.season === season && v.episode === episode,
    );
    targetBit = index >= 0 ? index : null;
  }
  if (alreadyWatched(type, item, targetBit)) return "already_watched";
  const now = Date.now();
  const row: ReadRow = {
    itemType: type,
    videoId,
    phase: "warmup",
    cycleStartedAt: now,
    expectedFlipAt: null,
    expectedEndAt: null,
    startState: startStateOf(item),
    lastTimeWatched: null,
    lastMovedAt: null,
    reads: 0,
    failures: 0,
  };
  // A resume shows the play at once; a new play shows it after it starts.
  const plan = planAfterRead(row, item, now);
  const { error } = await supabase.rpc(
    "watch_restart" as never,
    {
      p_account_id: accountId,
      p_item_id: itemId,
      p_item_type: type,
      p_video_id: videoId,
      p_due_at: iso(plan.next ?? now + 120_000),
      p_phase: plan.row.phase,
      p_start_state: row.startState,
      p_last_time_watched: plan.row.lastTimeWatched,
      p_expected_flip_at: iso(plan.row.expectedFlipAt),
      p_expected_end_at: iso(plan.row.expectedEndAt),
      p_reads: 1,
    } as never,
  );
  if (error) throw error;
  return plan.row.phase;
}

export async function watchContext(
  accountId: string,
): Promise<{ auth_key: string; destinations: string[] } | null> {
  const { data, error } = await supabase.rpc(
    "watch_context" as never,
    {
      p_account_id: accountId,
    } as never,
  );
  if (error) throw error;
  return (
    ((data ?? []) as { auth_key: string; destinations: string[] }[])[0] ?? null
  );
}
