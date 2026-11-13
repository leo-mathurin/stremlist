/**
 * The Destination writes of a cron run (ADR 0003). Trakt and MDBList go at
 * once. Simkl goes through one global limiter, in parallel with the rest of
 * the run: 1 POST a second, 3 while its oldest waiting write is more than 10
 * minutes old, and 1 again for an hour after a 429.
 *
 * The queue keeps one row per title and Destination. A series marked at once
 * goes out as one /sync request per Destination: the rows of one Account,
 * series and play time are sent together.
 */
import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../../lib/concurrency";
import { supabase } from "../../lib/supabase";
import { HttpError } from "../../providers/http";
import { isProviderEnabled } from "../../providers/registry";
import { traktPlays } from "../../providers/trakt/actions";
import type { ActionTarget } from "../../providers/types";
import {
  ConnectionExpiredError,
  UnknownTitleError,
} from "../../providers/types";
import { getAccountLists } from "../accounts";
import { performOnConnection } from "../actions";
import { getConnectionAccess } from "../connections";
import { nextWriteRetry } from "./schedule";

const CONCURRENCY = 10;
const OTHERS_BATCH = 300;
const LEASE_SECONDS = 90;
/** Most episodes in one /sync request. */
const EPISODES_PER_SEND = 100;
/**
 * Most requests to one Destination in one claim. Providers pace each user
 * (about one write a second), so more would wait past the claim's lease.
 */
const SENDS_PER_DESTINATION = 20;
const SIMKL_SLOW_RATE = 1;
const SIMKL_FAST_RATE = 3;
/** The oldest waiting Simkl write that switches to the fast rate. */
export const SIMKL_BACKLOG_ALERT_SECONDS = 10 * 60;
const SIMKL_SLOW_AFTER_429_SECONDS = 3600;

export interface ClaimedWrite {
  id: number;
  account_id: string;
  provider: string;
  imdb_id: string;
  item_type: string;
  season: number;
  episode: number;
  watched_at: string;
  attempts: number;
  first_failed_at: string | null;
  uncertain: boolean;
}

// A type alias, not an interface, so that it is assignable to the RPC's Json.
type WriteResult = {
  id: number;
  done: boolean;
  next_due_at: string | null;
  error: string | null;
  uncertain: boolean;
};

export interface WriteStats {
  sent: number;
  failed: number;
  gaveUp: number;
  rateLimited: boolean;
}

function newStats(): WriteStats {
  return { sent: 0, failed: 0, gaveUp: 0, rateLimited: false };
}

/** Stremio's time of the play, in the ISO form the Providers document. */
function watchedAt(write: ClaimedWrite): string {
  return new Date(write.watched_at).toISOString();
}

const isEpisode = (write: ClaimedWrite) => write.item_type === "series";
const episodeKey = (write: ClaimedWrite) => `${write.season}:${write.episode}`;

/**
 * The claimed rows in sends: the episodes of one Account, Provider, series
 * and play time together (up to EPISODES_PER_SEND), every other row alone.
 */
function groupSends(writes: ClaimedWrite[]): ClaimedWrite[][] {
  const groups = new Map<string, ClaimedWrite[][]>();
  const sends: ClaimedWrite[][] = [];
  for (const write of writes) {
    if (!isEpisode(write)) {
      sends.push([write]);
      continue;
    }
    const key = [
      write.account_id,
      write.provider,
      write.imdb_id,
      watchedAt(write),
    ].join("|");
    const chunks = groups.get(key) ?? [];
    const last = chunks.at(-1);
    if (last && last.length < EPISODES_PER_SEND) last.push(write);
    else {
      const chunk = [write];
      chunks.push(chunk);
      sends.push(chunk);
    }
    groups.set(key, chunks);
  }
  return sends;
}

interface CappedSends {
  kept: ClaimedWrite[][];
  /** Write IDs by the minutes they wait. */
  later: Map<number, number[]>;
}

/**
 * The sends of one claim, at most SENDS_PER_DESTINATION per Destination.
 * The others wait a minute per SENDS_PER_DESTINATION before them (`later`,
 * by minutes), so one bulk mark never holds back everyone else's writes. A
 * Provider turned off (kill switch) gets nothing: its rows wait 15 minutes.
 */
export function capPerDestination(sends: ClaimedWrite[][]): CappedSends {
  const count = new Map<string, number>();
  const kept: ClaimedWrite[][] = [];
  const later = new Map<number, number[]>();
  const wait = (minutes: number, group: ClaimedWrite[]) =>
    later.set(minutes, [
      ...(later.get(minutes) ?? []),
      ...group.map((w) => w.id),
    ]);
  for (const group of sends) {
    const provider = group[0].provider;
    if (isProviderId(provider) && !isProviderEnabled(provider)) {
      wait(15, group);
      continue;
    }
    const key = `${group[0].account_id}|${provider}`;
    const n = count.get(key) ?? 0;
    count.set(key, n + 1);
    if (n < SENDS_PER_DESTINATION) kept.push(group);
    else wait(Math.floor(n / SENDS_PER_DESTINATION), group);
  }
  return { kept, later };
}

function targetOf(writes: ClaimedWrite[]): ActionTarget {
  const [first] = writes;
  return {
    imdbId: first.imdb_id,
    type: first.item_type === "series" ? "series" : "movie",
    ...(isEpisode(first)
      ? {
          episodes: writes.map((w) => ({
            season: w.season,
            episode: w.episode,
          })),
        }
      : {}),
  };
}

/** Whether the Provider may have applied a write that got no answer. */
function isUncertain(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500;
  // A timeout or a network error after the request left.
  return !(
    error instanceof ConnectionExpiredError ||
    error instanceof UnknownTitleError
  );
}

/** The failure code shown on the configure page, or a retry reason. */
function errorCode(error: unknown): string {
  if (error instanceof ConnectionExpiredError) return "needs_renewal";
  if (error instanceof UnknownTitleError) return "not_found";
  if (error instanceof HttpError && error.status === 429) return "rate_limited";
  return "provider_error";
}

/** Which of `ids` this run still holds, just before it sends them. */
async function stillClaimed(
  ids: number[],
  lease: string,
): Promise<Set<number>> {
  const { data, error } = await supabase
    .from("watch_writes")
    .select("id")
    .in("id", ids)
    .eq("lease_token", lease);
  if (error) throw error;
  return new Set(data.map((row) => row.id));
}

/** Sends one group; one result per row it still holds. */
async function send(
  writes: ClaimedWrite[],
  lease: string,
  stats: WriteStats,
): Promise<WriteResult[]> {
  const [first] = writes;
  const finished = (rows: ClaimedWrite[]): WriteResult[] => {
    stats.sent += rows.length;
    return rows.map((w) => ({
      id: w.id,
      done: true,
      next_due_at: null,
      error: null,
      uncertain: false,
    }));
  };
  if (!isProviderId(first.provider)) return finished(writes);
  const provider: ProviderId = first.provider;
  let rows = writes;
  /** Set once a request may have reached the Provider. */
  let requested = false;
  try {
    // A Provider turned off (kill switch) gets no request: try again later.
    if (!isProviderEnabled(provider)) {
      throw new Error(`${provider} is turned off`);
    }
    const connection = await getConnectionAccess(first.account_id, provider);
    // Checked after the Connection read: a Connection deleted or given to
    // another Provider user meanwhile has deleted these rows.
    const held = await stillClaimed(
      writes.map((w) => w.id),
      lease,
    );
    rows = writes.filter((w) => held.has(w.id));
    if (rows.length === 0) return [];
    // The rows are still held, so the Connection exists: a failed read.
    if (!connection) throw new Error(`Cannot read the ${provider} Connection`);
    let pending = rows;
    if (provider === "trakt" && rows.some((w) => w.uncertain)) {
      // The last attempt may have reached Trakt, which adds a play per write.
      requested = true;
      const played = await traktPlays(
        connection,
        targetOf(rows),
        watchedAt(first),
      );
      pending = rows.filter(
        (w) => !played.has(isEpisode(w) ? episodeKey(w) : "movie"),
      );
    }
    if (pending.length > 0) {
      requested = true;
      await performOnConnection(
        connection,
        { kind: "watched", add: true, watchedAt: watchedAt(first) },
        targetOf(pending),
        await getAccountLists(first.account_id),
      );
    }
    return finished(rows);
  } catch (error) {
    stats.failed += rows.length;
    const code = errorCode(error);
    if (code === "rate_limited") stats.rateLimited = true;
    console.error(
      `Watch tracking write to ${provider} failed for ${first.account_id}:`,
      error instanceof Error ? error.message : error,
    );
    const now = Date.now();
    return rows.map((write) => {
      // A title the Provider does not know will not be known later.
      const next =
        code === "not_found"
          ? null
          : nextWriteRetry(
              write.attempts,
              write.first_failed_at ? Date.parse(write.first_failed_at) : now,
              now,
            );
      if (next === null) stats.gaveUp += 1;
      return {
        id: write.id,
        done: false,
        next_due_at: next === null ? null : new Date(next).toISOString(),
        error: code,
        // Still uncertain when the history check itself failed; a failure
        // before any request leaves it as it was.
        uncertain: write.uncertain || (requested && isUncertain(error)),
      };
    });
  }
}

async function claimWrites(
  provider: string,
  exclude: boolean,
  limit: number,
  lease: string,
): Promise<ClaimedWrite[]> {
  if (limit <= 0) return [];
  const { data, error } = await supabase.rpc("claim_watch_writes", {
    p_provider: provider,
    p_exclude: exclude,
    p_limit: limit,
    p_lease_seconds: LEASE_SECONDS,
    p_lease_token: lease,
  });
  if (error) throw error;
  return data;
}

async function finishWrites(
  lease: string,
  results: WriteResult[],
): Promise<void> {
  if (results.length === 0) return;
  const { error } = await supabase.rpc("finish_watch_writes", {
    p_lease_token: lease,
    p_rows: results,
  });
  if (error) throw error;
}

/**
 * Gives back claimed rows that this run did not start, no attempt counted,
 * due again in `delayMinutes`.
 */
async function releaseWrites(
  lease: string,
  ids: number[],
  delayMinutes = 0,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.rpc("release_watch_writes", {
    p_lease_token: lease,
    p_ids: ids,
    p_delay_seconds: delayMinutes * 60,
  });
  if (error) throw error;
}

async function releaseLater(
  lease: string,
  later: Map<number, number[]>,
): Promise<void> {
  for (const [minutes, ids] of later) await releaseWrites(lease, ids, minutes);
}

/**
 * Sends the groups of one claim until `deadline`, then stores every result
 * and gives back what was not started, whatever fails on the way. Returns
 * how many groups were not started.
 */
async function sendAll(
  groups: ClaimedWrite[][],
  lease: string,
  deadline: number,
  stats: WriteStats,
  run: (
    group: ClaimedWrite[],
    index: number,
    go: () => Promise<WriteResult[]>,
  ) => Promise<WriteResult[] | null>,
): Promise<number> {
  const results: WriteResult[] = [];
  const unsent: number[] = [];
  let unsentGroups = 0;
  try {
    await mapWithConcurrency(groups, CONCURRENCY, async (group, index) => {
      const outcome = await run(group, index, async () => {
        if (Date.now() >= deadline) return [];
        return send(group, lease, stats).catch((error: unknown) => {
          console.error("Watch tracking send failed:", error);
          return [];
        });
      });
      if (
        outcome === null ||
        (outcome.length === 0 && Date.now() >= deadline)
      ) {
        unsentGroups += 1;
        unsent.push(...group.map((w) => w.id));
      } else {
        results.push(...outcome);
      }
    });
  } finally {
    await finishWrites(lease, results);
    // Rows neither finished nor dropped by the database go back.
    const answered = new Set(results.map((r) => r.id));
    await releaseWrites(
      lease,
      unsent.filter((id) => !answered.has(id)),
    );
  }
  return unsentGroups;
}

/** Trakt and MDBList writes that are due, until `deadline`. */
export async function processWrites(deadline: number): Promise<WriteStats> {
  const stats = newStats();
  const lease = randomUUID();
  while (Date.now() < deadline) {
    const writes = await claimWrites("simkl", true, OTHERS_BATCH, lease);
    if (writes.length === 0) break;
    // Groups wait for a free slot (and a Provider's own pace per user): one
    // not started by the deadline goes back, so none outlives its lease.
    const { kept, later } = capPerDestination(groupSends(writes));
    await releaseLater(lease, later);
    const unsent = await sendAll(
      kept,
      lease,
      deadline,
      stats,
      (_group, _index, go) => go(),
    );
    if (unsent > 0 || writes.length < OTHERS_BATCH) break;
  }
  return stats;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The age of the oldest Simkl write never tried yet, in seconds. */
export async function simklBacklogSeconds(): Promise<number> {
  const { data, error } = await supabase.rpc("watch_simkl_backlog");
  if (error) throw error;
  return data;
}

/**
 * Simkl writes through the global limiter, until `deadline`. Each group
 * waits for its own slot, so the fast rate is reached even when one answer
 * is slow.
 */
export async function processSimklWrites(
  deadline: number,
  backlogSeconds: number,
): Promise<WriteStats> {
  const stats = newStats();
  const windowSeconds = (deadline - Date.now()) / 1000 - 2;
  if (windowSeconds <= 1) return stats;
  const wanted =
    backlogSeconds > SIMKL_BACKLOG_ALERT_SECONDS
      ? SIMKL_FAST_RATE
      : SIMKL_SLOW_RATE;
  const { data, error } = await supabase.rpc("take_simkl_slots", {
    p_want: Math.ceil(windowSeconds * wanted),
    p_rate: wanted,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  const gate = data.at(0);
  if (!gate || gate.granted === 0) return stats;
  const lease = randomUUID();
  const first = Date.parse(gate.first_slot_at);
  let unused = gate.granted;
  try {
    // One slot per /sync request: claim rows until the slots are used.
    const writes = await claimWrites(
      "simkl",
      false,
      Math.min(gate.granted * EPISODES_PER_SEND, 1000),
      lease,
    );
    const { kept: groups, later } = capPerDestination(groupSends(writes));
    const sendable = groups.slice(0, gate.granted);
    await releaseLater(lease, later);
    await releaseWrites(
      lease,
      groups.slice(gate.granted).flatMap((g) => g.map((w) => w.id)),
    );
    unused -= sendable.length;
    const skipped = await sendAll(
      sendable,
      lease,
      deadline,
      stats,
      async (_group, index, go) => {
        await sleep(
          Math.max(0, first + (index * 1000) / gate.rate - Date.now()),
        );
        // Simkl refused one: the rest wait for a later run.
        if (stats.rateLimited) return null;
        return go();
      },
    );
    unused += Math.min(skipped, sendable.length);
  } finally {
    if (unused > 0 || stats.rateLimited) {
      const { error: returnError } = await supabase.rpc("return_simkl_slots", {
        p_unused: unused,
        p_rate: gate.rate,
        p_slow_seconds: stats.rateLimited ? SIMKL_SLOW_AFTER_429_SECONDS : 0,
      });
      if (returnError)
        console.error("Failed to return Simkl slots:", returnError);
    }
  }
  return stats;
}
