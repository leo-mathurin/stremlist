import { describe, expect, it } from "vite-plus/test";
import type { LibraryItem } from "../../stremio";
import {
  newCycle,
  nextWriteRetry,
  planAfterFailure,
  planAfterRead,
} from "../schedule";

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-12T20:00:00.000Z");

function playing(watched: number, at: number) {
  return {
    _id: "tt0063350",
    type: "movie",
    _mtime: new Date(at).toISOString(),
    state: {
      video_id: "tt0063350",
      duration: 100 * MINUTE,
      timeWatched: watched * MINUTE,
      timesWatched: 0,
    },
  };
}

function cycle(item?: LibraryItem) {
  return newCycle("movie", "tt0063350", item, T0);
}

describe("the read schedule", () => {
  it("waits for the threshold, then reads every 2 minutes", () => {
    const first = planAfterRead(cycle(), playing(0, T0), false, T0);
    expect(first.row.expectedFlipAt).toBe(T0 + 70 * MINUTE);
    expect(first.row.phase).toBe("wait");
    expect(first.next).toBe(T0 + 70 * MINUTE);

    const at = T0 + 70 * MINUTE;
    const flip = planAfterRead(first.row, playing(70, at), false, at);
    expect(flip.row.phase).toBe("flip");
    expect(flip.next).toBe(at + 2 * MINUTE);
  });

  it("ends the cycle on the read that found the watch", () => {
    const plan = planAfterRead(cycle(), playing(0, T0), true, T0);
    expect(plan).toMatchObject({ next: null, stopReason: "detected" });
  });

  it("slows down 5 minutes after the progress stopped", () => {
    let row = planAfterRead(cycle(), playing(0, T0), false, T0).row;
    row = { ...row, phase: "flip" };
    const at = T0 + 10 * MINUTE;
    row = planAfterRead(row, playing(10, at), false, at).row;
    const soon = planAfterRead(row, playing(10, at), false, at + 4 * MINUTE);
    expect(soon.row.phase).not.toBe("stalled");
    const stalled = planAfterRead(
      soon.row,
      playing(10, at),
      false,
      at + 5 * MINUTE,
    );
    expect(stalled.row.phase).toBe("stalled");
    expect(stalled.next).toBe(at + 35 * MINUTE);
    const end = stalled.row.expectedEndAt ?? 0;
    const last = planAfterRead(stalled.row, playing(10, at), false, end);
    expect(last).toMatchObject({ next: null, stopReason: "stalled_end" });
  });

  it("gives up a play that never shows in the library", () => {
    let plan = planAfterRead(cycle(), undefined, false, T0);
    expect(plan.next).toBe(T0 + 2 * MINUTE);
    plan = planAfterRead(plan.row, undefined, false, T0 + 10 * MINUTE);
    expect(plan).toMatchObject({ next: null, stopReason: "never_started" });
  });

  it("stops 3 hours after the expected end", () => {
    const row = planAfterRead(cycle(), playing(0, T0), false, T0).row;
    const after = T0 + 100 * MINUTE + 3 * 60 * MINUTE + 1;
    const plan = planAfterRead(
      { ...row, lastTimeWatched: 99 * MINUTE, lastMovedAt: after - MINUTE },
      playing(99, after),
      false,
      after,
    );
    expect(plan).toMatchObject({ next: null, stopReason: "after_end" });
  });

  it("tries a failed read again in a minute", () => {
    const plan = planAfterFailure(cycle(), T0 + MINUTE);
    expect(plan.next).toBe(T0 + 2 * MINUTE);
    expect(plan.row.failures).toBe(1);
  });
});

describe("the write retries", () => {
  it("wait 1, 5 and 30 minutes, then 6 hours, for 72 hours", () => {
    expect(nextWriteRetry(0, T0, T0)).toBe(T0 + MINUTE);
    expect(nextWriteRetry(1, T0, T0)).toBe(T0 + 5 * MINUTE);
    expect(nextWriteRetry(2, T0, T0)).toBe(T0 + 30 * MINUTE);
    expect(nextWriteRetry(3, T0, T0)).toBe(T0 + 360 * MINUTE);
    expect(nextWriteRetry(9, T0, T0 + 72 * 60 * MINUTE + 1)).toBeNull();
  });
});
