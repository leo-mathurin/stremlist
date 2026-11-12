/**
 * The Destination writes of a cron run (ADR 0003). Trakt and MDBList go at
 * once. Simkl goes through one global limiter, in parallel with the rest of
 * the run: 1 POST a second, 3 while its oldest due write waits more than 10
 * minutes, and 1 again for an hour after a 429.
 */
import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../../lib/concurrency";
import { supabase } from "../../lib/supabase";
import { HttpError } from "../../providers/http";
import { traktHasPlay } from "../../providers/trakt/actions";
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
const SIMKL_SLOW_RATE = 1;
const SIMKL_FAST_RATE = 3;
/** The oldest due Simkl write that switches to the fast rate. */
export const SIMKL_BACKLOG_ALERT_SECONDS = 10 * 60;
const SIMKL_SLOW_AFTER_429_SECONDS = 3600;

interface ClaimedWrite {
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

interface WriteResult {
  id: number;
  done: boolean;
  next_due_at: string | null;
  error: string | null;
  uncertain: boolean;
}

export interface WriteStats {
  sent: number;
  failed: number;
  gaveUp: number;
  rateLimited: boolean;
}

function newStats(): WriteStats {
  return { sent: 0, failed: 0, gaveUp: 0, rateLimited: false };
}

function targetOf(write: ClaimedWrite): ActionTarget {
  return {
    imdbId: write.imdb_id,
    type: write.item_type === "series" ? "series" : "movie",
    ...(write.season > 0 || write.episode > 0
      ? { episode: { season: write.season, episode: write.episode } }
      : {}),
  };
}

/** Stremio's time of the play, in the ISO form the Providers document. */
function watchedAt(write: ClaimedWrite): string {
  return new Date(write.watched_at).toISOString();
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

async function sendWrite(
  write: ClaimedWrite,
  stats: WriteStats,
): Promise<WriteResult> {
  const done = (): WriteResult => {
    stats.sent += 1;
    return {
      id: write.id,
      done: true,
      next_due_at: null,
      error: null,
      uncertain: false,
    };
  };
  if (!isProviderId(write.provider)) return done();
  const provider: ProviderId = write.provider;
  const target = targetOf(write);
  try {
    const connection = await getConnectionAccess(write.account_id, provider);
    // The Connection is gone: the database dropped the Destination with it.
    if (!connection) return done();
    if (write.uncertain && provider === "trakt") {
      // The last attempt may have reached Trakt, which adds a play per write.
      if (await traktHasPlay(connection, target, watchedAt(write))) {
        return done();
      }
    }
    await performOnConnection(
      connection,
      { kind: "watched", add: true, watchedAt: watchedAt(write) },
      target,
      await getAccountLists(write.account_id),
    );
    return done();
  } catch (error) {
    stats.failed += 1;
    const code = errorCode(error);
    if (code === "rate_limited") stats.rateLimited = true;
    const now = Date.now();
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
    console.error(
      `Watch tracking write to ${provider} failed for ${write.account_id}:`,
      error instanceof Error ? error.message : error,
    );
    return {
      id: write.id,
      done: false,
      next_due_at: next === null ? null : new Date(next).toISOString(),
      error: code,
      // Still uncertain when the history check itself failed.
      uncertain: write.uncertain || isUncertain(error),
    };
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
  return data as unknown as ClaimedWrite[];
}

async function finishWrites(
  lease: string,
  results: WriteResult[],
): Promise<void> {
  if (results.length === 0) return;
  const { error } = await supabase.rpc("finish_watch_writes", {
    p_lease_token: lease,
    p_rows: results as never,
  });
  if (error) throw error;
}

/** Trakt and MDBList writes that are due, until `deadline`. */
export async function processWrites(deadline: number): Promise<WriteStats> {
  const stats = newStats();
  const lease = randomUUID();
  while (Date.now() < deadline) {
    const writes = await claimWrites("simkl", true, OTHERS_BATCH, lease);
    if (writes.length === 0) break;
    // Writes wait for a free slot: each is checked again just before it goes.
    const results = await mapWithConcurrency(
      writes,
      CONCURRENCY,
      async (write) =>
        (await stillClaimed(write.id, lease)) ? sendWrite(write, stats) : null,
    );
    await finishWrites(
      lease,
      results.filter((result) => result !== null),
    );
    if (writes.length < OTHERS_BATCH) break;
  }
  return stats;
}

/** Whether this run still holds the write, just before it sends it. */
async function stillClaimed(id: number, lease: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("watch_writes")
    .select("id")
    .eq("id", id)
    .eq("lease_token", lease)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The age of the oldest due Simkl write, in seconds. */
export async function simklBacklogSeconds(): Promise<number> {
  const { data, error } = await supabase.rpc("watch_simkl_backlog");
  if (error) throw error;
  return data;
}

/** Simkl writes through the global limiter, until `deadline`. */
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
  const writes = await claimWrites("simkl", false, gate.granted, lease);
  const first = Date.parse(gate.first_slot_at);
  let unused = gate.granted - writes.length;
  const results: WriteResult[] = [];
  for (const [index, write] of writes.entries()) {
    if (stats.rateLimited) {
      // Simkl refused one: give the rest back for a later run.
      unused += 1;
      results.push({
        id: write.id,
        done: false,
        next_due_at: new Date(Date.now() + 60_000).toISOString(),
        error: "rate_limited",
        uncertain: write.uncertain,
      });
      continue;
    }
    await sleep(Math.max(0, first + (index * 1000) / gate.rate - Date.now()));
    // During the wait the Destination may have been turned off or its
    // Connection given to another Simkl user: the database dropped the write.
    if (!(await stillClaimed(write.id, lease))) {
      unused += 1;
      continue;
    }
    results.push(await sendWrite(write, stats));
  }
  await finishWrites(lease, results);
  if (unused > 0 || stats.rateLimited) {
    const { error: returnError } = await supabase.rpc("return_simkl_slots", {
      p_unused: unused,
      p_rate: gate.rate,
      p_slow_seconds: stats.rateLimited ? SIMKL_SLOW_AFTER_429_SECONDS : 0,
    });
    if (returnError) throw returnError;
  }
  return stats;
}
