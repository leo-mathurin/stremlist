/**
 * SPIKE: when to read a library item again (ADR 0003). Pure.
 *
 * - A /stream request reads at once. Until the play shows its duration, read
 *   every 2 minutes (warmup), for at most 10 minutes.
 * - Then wait until the earliest time the item can turn watched, read every
 *   2 minutes for 30 minutes, every 5 minutes after, and stop 3 hours after
 *   the expected end.
 * - When timeWatched has not moved for 10 minutes, read every 30 minutes
 *   until the expected end, then stop.
 */
import type { LibraryItem } from "./library";
import { mtimeOf, watchedBits } from "./library";

const MINUTE = 60_000;
const THRESHOLD = 0.7;
const STALL_MS = 10 * MINUTE;
const DEFAULT_DURATION_MS = { movie: 120 * MINUTE, series: 45 * MINUTE };

export interface StartState {
  timesWatched?: number;
  bits?: string;
}

export interface ReadRow {
  itemType: "movie" | "series";
  videoId: string;
  phase: string;
  cycleStartedAt: number;
  expectedFlipAt: number | null;
  expectedEndAt: number | null;
  startState: StartState;
  lastTimeWatched: number | null;
  lastMovedAt: number | null;
  reads: number;
  failures: number;
}

export interface Plan {
  next: number | null;
  row: ReadRow;
  /** New watched episodes (bit indexes) or the movie itself. */
  detected: null | { movie: true } | { bits: number[]; field: string };
  stopReason?: string;
}

export function startStateOf(item: LibraryItem | undefined): StartState {
  return {
    timesWatched: item?.state?.timesWatched ?? 0,
    bits: item?.state?.watched ?? "",
  };
}

function detect(row: ReadRow, item: LibraryItem): Plan["detected"] {
  const state = item.state ?? {};
  if (row.itemType === "movie") {
    return (row.startState.timesWatched ?? 0) === 0 &&
      (state.timesWatched ?? 0) > 0
      ? { movie: true }
      : null;
  }
  if (!state.watched || state.watched === row.startState.bits) return null;
  const before = watchedBits(row.startState.bits);
  const fresh = [...watchedBits(state.watched)].filter((b) => !before.has(b));
  return fresh.length > 0 ? { bits: fresh, field: state.watched } : null;
}

/** The next read after a successful read (`item` undefined: not in the library). */
export function planAfterRead(
  input: ReadRow,
  item: LibraryItem | undefined,
  now: number,
): Plan {
  const row: ReadRow = { ...input, reads: input.reads + 1, failures: 0 };
  if (item) {
    const detected = detect(row, item);
    if (detected) return { next: null, row, detected, stopReason: "detected" };
  }
  const state = item?.state ?? {};
  const timeWatched = state.timeWatched ?? 0;
  const moved =
    row.lastTimeWatched === null || timeWatched !== row.lastTimeWatched;
  if (moved) row.lastMovedAt = now;
  row.lastTimeWatched = timeWatched;

  const playing =
    !!item && state.video_id === row.videoId && (state.duration ?? 0) > 0;
  // The first read that sees the play sets the expectation even when
  // timeWatched is still 0 (a web client pushes only every 180 s).
  if (playing && (moved || input.phase === "warmup")) {
    // The cloud got timeWatched at _mtime; assume playback at real speed.
    // On the /stream read itself the play (re)starts now.
    const at = input.reads === 0 ? now : mtimeOf(item) || now;
    const duration = state.duration ?? 0;
    row.expectedFlipAt = at + Math.max(0, THRESHOLD * duration - timeWatched);
    row.expectedEndAt = at + Math.max(0, duration - timeWatched);
  }

  if (!playing && row.phase === "warmup") {
    if (now - row.cycleStartedAt < STALL_MS)
      return { next: now + 2 * MINUTE, row, detected: null };
    return { next: null, row, detected: null, stopReason: "never_started" };
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
    if (now >= endAt)
      return { next: null, row, detected: null, stopReason: "stalled_end" };
    return { next: Math.min(now + 30 * MINUTE, endAt), row, detected: null };
  }
  if (now > endAt + 3 * 60 * MINUTE)
    return { next: null, row, detected: null, stopReason: "after_end" };
  if (now < flipAt - 2 * MINUTE) {
    row.phase = "wait";
    return { next: flipAt, row, detected: null };
  }
  row.phase = "flip";
  const step = now < flipAt + 30 * MINUTE ? 2 * MINUTE : 5 * MINUTE;
  return { next: now + step, row, detected: null };
}

/** The next read after a failed read: in 1 minute. */
export function planAfterFailure(input: ReadRow, now: number): Plan {
  return {
    next: now + MINUTE,
    row: { ...input, failures: input.failures + 1 },
    detected: null,
  };
}

/** Whether the target of a /stream request is already watched. */
export function alreadyWatched(
  itemType: "movie" | "series",
  item: LibraryItem | undefined,
  bitOfTarget: number | null,
): boolean {
  if (!item) return false;
  if (itemType === "movie") return (item.state?.timesWatched ?? 0) > 0;
  return (
    bitOfTarget !== null && watchedBits(item.state?.watched).has(bitOfTarget)
  );
}

/** Retry delays of a failed Destination write; null after 72 hours. */
export function nextWriteRetry(
  attempts: number,
  firstFailedAt: number,
  now: number,
): number | null {
  if (now - firstFailedAt > 72 * 60 * MINUTE) return null;
  const delays = [1, 5, 30];
  return now + (delays[attempts] ?? 360) * MINUTE;
}
