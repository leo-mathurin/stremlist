/**
 * When to read a library item again (ADR 0003). Pure.
 *
 * - A /stream request reads at once. Until the play shows in the library,
 *   read every 2 minutes (warmup), for at most 10 minutes.
 * - Then wait until the earliest time the item can turn watched, read every
 *   2 minutes for 30 minutes, every 5 minutes after, and stop 3 hours after
 *   the expected end.
 * - When `timeWatched` has not moved for 5 minutes, the playback stopped:
 *   read every 30 minutes until the expected end, then stop.
 */
import { z } from "zod";
import type { LibraryItem } from "../stremio";
import { mtimeOf } from "./library";

const MINUTE = 60_000;
/** Stremio's own threshold (`WATCHED_THRESHOLD_COEF`). */
const THRESHOLD = 0.7;
const WARMUP_MS = 10 * MINUTE;
/** Android TV writes its progress every 90 s: 3 missed writes. */
const STALL_MS = 5 * MINUTE;
const AFTER_END_MS = 3 * 60 * MINUTE;
const DEFAULT_DURATION_MS = { movie: 120 * MINUTE, series: 45 * MINUTE };

/** What was watched when the cycle started. */
export const startStateSchema = z.object({
  timesWatched: z.number().optional(),
  /** The series' `watched` field. */
  bits: z.string().optional(),
});
type StartState = z.infer<typeof startStateSchema>;

export const PHASES = ["warmup", "wait", "flip", "stalled"] as const;
type Phase = (typeof PHASES)[number];

export interface ReadRow {
  itemType: "movie" | "series";
  videoId: string;
  phase: Phase;
  cycleStartedAt: number;
  expectedFlipAt: number | null;
  expectedEndAt: number | null;
  startState: StartState;
  lastTimeWatched: number | null;
  lastMovedAt: number | null;
  reads: number;
  failures: number;
}

type StopReason = "detected" | "never_started" | "stalled_end" | "after_end";

export interface Plan {
  /** The next read, or null when the cycle ends. */
  next: number | null;
  row: ReadRow;
  stopReason?: StopReason;
}

function startStateOf(item: LibraryItem | undefined): StartState {
  return {
    timesWatched: item?.state?.timesWatched ?? 0,
    bits: item?.state?.watched ?? "",
  };
}

/** A new cycle, for the read of a /stream request. */
export function newCycle(
  itemType: "movie" | "series",
  videoId: string,
  item: LibraryItem | undefined,
  now: number,
): ReadRow {
  return {
    itemType,
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
}

/**
 * The next read after a successful read. `item` is undefined when the title
 * is not in the library; `detected` says whether this read found a new
 * watched title, which ends the cycle.
 */
export function planAfterRead(
  input: ReadRow,
  item: LibraryItem | undefined,
  detected: boolean,
  now: number,
): Plan {
  const row: ReadRow = { ...input, reads: input.reads + 1, failures: 0 };
  if (detected) return { next: null, row, stopReason: "detected" };

  const state = item?.state ?? {};
  const timeWatched = state.timeWatched ?? 0;
  const moved =
    row.lastTimeWatched === null || timeWatched !== row.lastTimeWatched;
  if (moved) row.lastMovedAt = now;
  row.lastTimeWatched = timeWatched;

  const playing =
    !!item && state.video_id === row.videoId && (state.duration ?? 0) > 0;
  // The first read that sees the play sets the expectation, even when
  // timeWatched is still 0 (Stremio Web pushes only every 180 s).
  if (playing && (moved || input.phase === "warmup")) {
    // The cloud got timeWatched at _mtime; assume playback at real speed.
    // On the /stream read itself, the play (re)starts now.
    const at = input.reads === 0 ? now : mtimeOf(item) || now;
    const duration = state.duration ?? 0;
    row.expectedFlipAt = at + Math.max(0, THRESHOLD * duration - timeWatched);
    row.expectedEndAt = at + Math.max(0, duration - timeWatched);
  }

  if (!playing && row.phase === "warmup") {
    if (now - row.cycleStartedAt < WARMUP_MS) {
      return { next: now + 2 * MINUTE, row };
    }
    return { next: null, row, stopReason: "never_started" };
  }
  if (row.expectedEndAt === null) {
    const duration = DEFAULT_DURATION_MS[row.itemType];
    row.expectedFlipAt = row.cycleStartedAt + THRESHOLD * duration;
    row.expectedEndAt = row.cycleStartedAt + duration;
  }
  const flipAt = row.expectedFlipAt ?? now;
  const endAt = row.expectedEndAt;

  if (!moved && now - (row.lastMovedAt ?? now) >= STALL_MS) {
    row.phase = "stalled";
    if (now >= endAt) return { next: null, row, stopReason: "stalled_end" };
    return { next: Math.min(now + 30 * MINUTE, endAt), row };
  }
  if (now > endAt + AFTER_END_MS) {
    return { next: null, row, stopReason: "after_end" };
  }
  if (now < flipAt - 2 * MINUTE) {
    row.phase = "wait";
    return { next: flipAt, row };
  }
  row.phase = "flip";
  const step = now < flipAt + 30 * MINUTE ? 2 * MINUTE : 5 * MINUTE;
  return { next: now + step, row };
}

/** After a failed read: again in 1 minute, for at most 3 hours. */
export function planAfterFailure(input: ReadRow, now: number): Plan {
  const row = { ...input, failures: input.failures + 1 };
  if (now - row.cycleStartedAt > AFTER_END_MS + DEFAULT_DURATION_MS.movie) {
    return { next: null, row, stopReason: "after_end" };
  }
  return { next: now + MINUTE, row };
}

/** When to try a failed Destination write again; null after 72 hours. */
export function nextWriteRetry(
  attempts: number,
  firstFailedAt: number,
  now: number,
): number | null {
  if (now - firstFailedAt > 72 * 60 * MINUTE) return null;
  const delays = [1, 5, 30];
  return now + (delays[attempts] ?? 360) * MINUTE;
}
