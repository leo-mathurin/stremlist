import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../../lib/concurrency";
import { isConnectionReset } from "../../lib/connection-reset";
import { supabase } from "../../lib/supabase";
import { HttpError } from "../../providers/http";
import type { ActionTarget } from "../../providers/types";
import { isProviderEnabled } from "../../providers/registry";
import { traktPlays } from "../../providers/trakt/actions";
import {
  ConnectionExpiredError,
  UnknownTitleError,
} from "../../providers/types";
import { getAccountLists } from "../accounts";
import { performOnConnection, SimklWriteBusyError } from "../actions";
import { getConnectionAccess } from "../connections";
import { nextWriteRetry } from "./schedule";

const CONCURRENCY = 10;
const OTHERS_BATCH = 300;
const LEASE_SECONDS = 90;
const EPISODES_PER_SEND = 100;
const SENDS_PER_DESTINATION = 20;
const SIMKL_SLOW_RATE = 1;
const SIMKL_FAST_RATE = 3;
/** The oldest waiting Simkl write that switches to the fast rate. */
export const SIMKL_BACKLOG_ALERT_SECONDS = 10 * 60;
const SIMKL_SLOW_AFTER_429_SECONDS = 3600;

export interface ClaimedWrite {
  id: number;
  kind: string;
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
  /** Writes whose send lost its connection to a reset; they are retried. */
  resets: number;
  rateLimited: boolean;
}

function newStats() {
  return { sent: 0, failed: 0, gaveUp: 0, resets: 0, rateLimited: false };
}

function watchedAt(write: ClaimedWrite) {
  return new Date(write.watched_at).toISOString();
}

const isEpisode = (write: ClaimedWrite) => write.item_type === "series";
const episodeKey = (write: ClaimedWrite) => `${write.season}:${write.episode}`;

function groupSends(writes: ClaimedWrite[]) {
  const groups = new Map<string, ClaimedWrite[][]>();
  const sends: ClaimedWrite[][] = [];
  for (const write of writes) {
    if (!isEpisode(write) || write.kind === "watchlist") {
      sends.push([write]);
      continue;
    }
    const key = [
      write.account_id,
      write.kind,
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
  later: Map<number, number[]>;
}

/**
 * The sends of one claim, at most SENDS_PER_DESTINATION per Destination.
 * The others wait a minute per SENDS_PER_DESTINATION before them (`later`,
 * by minutes), so one bulk mark never holds back everyone else's writes. A
 * Provider turned off (kill switch) gets nothing: its rows wait 15 minutes.
 */
export function capPerDestination(sends: ClaimedWrite[][]) {
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
  return { kept, later } satisfies CappedSends;
}

function targetOf(writes: ClaimedWrite[]) {
  const [first] = writes;
  return {
    imdbId: first.imdb_id,
    type: first.item_type === "series" ? "series" : "movie",
    ...(isEpisode(first) && first.kind !== "watchlist"
      ? {
          episodes: writes.map((w) => ({
            season: w.season,
            episode: w.episode,
          })),
        }
      : {}),
  } satisfies ActionTarget;
}

function isUncertain(error: unknown) {
  if (error instanceof HttpError) return error.status >= 500;
  return !(
    error instanceof ConnectionExpiredError ||
    error instanceof UnknownTitleError
  );
}

function errorCode(error: unknown) {
  if (error instanceof ConnectionExpiredError) return "needs_renewal";
  if (error instanceof UnknownTitleError) return "not_found";
  if (error instanceof HttpError && error.status === 429) return "rate_limited";
  return "provider_error";
}

async function stillClaimed(ids: number[], lease: string) {
  const { data, error } = await supabase
    .from("watch_writes")
    .select("id")
    .in("id", ids)
    .eq("lease_token", lease);
  if (error) throw error;
  return new Set(data.map((row) => row.id));
}

async function send(writes: ClaimedWrite[], lease: string, stats: WriteStats) {
  const [first] = writes;
  const finished = (rows: ClaimedWrite[]) => {
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
  let requested = false;
  try {
    if (!isProviderEnabled(provider)) {
      throw new Error(`${provider} is turned off`);
    }
    const connection = await getConnectionAccess(first.account_id, provider);
    const held = await stillClaimed(
      writes.map((w) => w.id),
      lease,
    );
    rows = writes.filter((w) => held.has(w.id));
    if (rows.length === 0) return [];
    if (!connection) throw new Error(`Cannot read the ${provider} Connection`);
    let pending = rows;
    if (
      first.kind !== "watchlist" &&
      provider === "trakt" &&
      rows.some((w) => w.uncertain)
    ) {
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
        first.kind === "watchlist"
          ? { kind: "watchlist", add: true, preserveExistingStatus: true }
          : { kind: "watched", add: true, watchedAt: watchedAt(first) },
        targetOf(pending),
        await getAccountLists(first.account_id),
      );
    }
    return finished(rows);
  } catch (error) {
    if (error instanceof SimklWriteBusyError) {
      await releaseWrites(
        lease,
        rows.map((row) => row.id),
        1,
      );
      return [];
    }
    const code = errorCode(error);
    if (isConnectionReset(error)) stats.resets += rows.length;
    else if (code !== "not_found") stats.failed += rows.length;
    if (code === "rate_limited") stats.rateLimited = true;
    console.error(
      `Watch tracking write to ${provider} failed for ${first.account_id}:`,
      error instanceof Error ? error.message : error,
    );
    const now = Date.now();
    return rows.map((write) => {
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
) {
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

async function finishWrites(lease: string, results: WriteResult[]) {
  if (results.length === 0) return;
  const { error } = await supabase.rpc("finish_watch_writes", {
    p_lease_token: lease,
    p_rows: results,
  });
  if (error) throw error;
}

async function releaseWrites(lease: string, ids: number[], delayMinutes = 0) {
  if (ids.length === 0) return;
  const { error } = await supabase.rpc("release_watch_writes", {
    p_lease_token: lease,
    p_ids: ids,
    p_delay_seconds: delayMinutes * 60,
  });
  if (error) throw error;
}

async function releaseLater(lease: string, later: Map<number, number[]>) {
  for (const [minutes, ids] of later) await releaseWrites(lease, ids, minutes);
}

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
) {
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
    const answered = new Set(results.map((r) => r.id));
    await releaseWrites(
      lease,
      unsent.filter((id) => !answered.has(id)),
    );
  }
  return unsentGroups;
}

/** Trakt and MDBList writes that are due, until `deadline`. */
export async function processWrites(deadline: number) {
  const stats = newStats();
  const lease = randomUUID();
  while (Date.now() < deadline) {
    const writes = await claimWrites("simkl", true, OTHERS_BATCH, lease);
    if (writes.length === 0) break;
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
export async function simklBacklogSeconds() {
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
) {
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
