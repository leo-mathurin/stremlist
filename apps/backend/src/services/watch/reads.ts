/**
 * The due reads of a cron run (ADR 0003): claim a batch with one RPC, read
 * each item from Stremio, record new watched titles, and store the next read.
 */
import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../../lib/concurrency";
import { decryptSecret } from "../../lib/crypto";
import { supabase } from "../../lib/supabase";
import type { LibraryItem } from "../stremio";
import { recordItems } from "./detect";
import { readLibraryItems } from "./pace";
import type { Plan, ReadRow } from "./schedule";
import {
  PHASES,
  planAfterFailure,
  planAfterRead,
  startStateSchema,
} from "./schedule";
import { linkOf } from "./state";
import { destinationsNow } from "./sweep";

const BATCH = 200;
const CONCURRENCY = 20;
const LEASE_SECONDS = 120;

/** A claimed read, as `claim_watch_reads` returns it. */
const claimedReadSchema = z.object({
  account_id: z.string(),
  item_id: z.string(),
  item_type: z.string(),
  video_id: z.string(),
  due_at: z.string(),
  generation: z.number(),
  phase: z.enum(PHASES),
  cycle_started_at: z.string(),
  expected_flip_at: z.string().nullable(),
  expected_end_at: z.string().nullable(),
  start_state: startStateSchema.nullable(),
  last_time_watched: z.number().nullable(),
  last_moved_at: z.string().nullable(),
  reads: z.number(),
  failures: z.number(),
  auth_key: z.string().nullable(),
  baseline_at: z.string().nullable(),
  stremio_trakt: z.boolean(),
  destinations: z.array(z.string()).nullable(),
});
type ClaimedRead = z.infer<typeof claimedReadSchema>;

export interface ReadStats {
  claimed: number;
  read: number;
  failed: number;
  detected: number;
  /** The most a due read waited, in ms. */
  maxLagMs: number;
}

const time = (value: string | null) => (value ? Date.parse(value) : null);
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();

function toRow(claimed: ClaimedRead): ReadRow {
  return {
    itemType: claimed.item_type === "series" ? "series" : "movie",
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

/** Whether `item` changed its watched status since the cycle started. */
function changedSinceStart(
  row: ReadRow,
  item: LibraryItem | undefined,
): boolean {
  if (!item) return false;
  if (row.itemType === "movie") {
    return (
      (row.startState.timesWatched ?? 0) === 0 &&
      (item.state?.timesWatched ?? 0) > 0
    );
  }
  return !!item.state?.watched && item.state.watched !== row.startState.bits;
}

function destinationsOf(claimed: ClaimedRead): ProviderId[] {
  return (claimed.destinations ?? []).filter(isProviderId);
}

async function readOne(claimed: ClaimedRead, stats: ReadStats): Promise<Plan> {
  const row = toRow(claimed);
  // No Stremio link any more: the cycle ends.
  if (!claimed.auth_key) return { next: null, row };
  try {
    const authKey = decryptSecret(claimed.auth_key);
    const [item] = await readLibraryItems(authKey, [claimed.item_id]);
    let detected = false;
    // Before the Watched baseline nothing is sent: the baseline has it.
    if (claimed.baseline_at && changedSinceStart(row, item)) {
      const titles = await recordItems(
        claimed.account_id,
        await destinationsNow(
          claimed.account_id,
          authKey,
          destinationsOf(claimed),
          claimed.stremio_trakt,
        ),
        [item],
        { link: linkOf(claimed.auth_key) },
      );
      detected = titles.length > 0;
      if (detected) stats.detected += 1;
    }
    stats.read += 1;
    return planAfterRead(row, item, detected, Date.now());
  } catch (error) {
    stats.failed += 1;
    console.error(
      `Watch tracking read of ${claimed.item_id} failed:`,
      error instanceof Error ? error.message : error,
    );
    return planAfterFailure(row, Date.now());
  }
}

/** Reads due items until none is left or `deadline` passes. */
export async function processReads(deadline: number): Promise<ReadStats> {
  const stats: ReadStats = {
    claimed: 0,
    read: 0,
    failed: 0,
    detected: 0,
    maxLagMs: 0,
  };
  const lease = randomUUID();
  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc("claim_watch_reads", {
      p_limit: BATCH,
      p_lease_seconds: LEASE_SECONDS,
      p_lease_token: lease,
    });
    if (error) throw error;
    const claimed = z.array(claimedReadSchema).parse(data);
    if (claimed.length === 0) break;
    stats.claimed += claimed.length;
    const now = Date.now();
    for (const row of claimed) {
      stats.maxLagMs = Math.max(stats.maxLagMs, now - Date.parse(row.due_at));
    }
    const plans = await mapWithConcurrency(claimed, CONCURRENCY, (row) =>
      readOne(row, stats),
    );
    const { error: finishError } = await supabase.rpc("finish_watch_reads", {
      p_lease_token: lease,
      p_rows: claimed.map((row, index) => {
        const plan = plans[index];
        return {
          account_id: row.account_id,
          item_id: row.item_id,
          generation: row.generation,
          next_due_at: iso(plan.next),
          phase: plan.row.phase,
          expected_flip_at: iso(plan.row.expectedFlipAt),
          expected_end_at: iso(plan.row.expectedEndAt),
          last_time_watched: plan.row.lastTimeWatched,
          last_moved_at: iso(plan.row.lastMovedAt),
          reads: plan.row.reads,
          failures: plan.row.failures,
        };
      }),
    });
    if (finishError) throw finishError;
    if (claimed.length < BATCH) break;
  }
  return stats;
}
