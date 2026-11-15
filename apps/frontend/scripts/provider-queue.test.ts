import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  previewQueueMessage,
  queueLabel,
  queueProgress,
  queueWait,
  retryDelay,
} from "../src/lib/provider-queue.ts";

const T = 1_800_000_000_000;

describe("queue state", () => {
  const wait = queueWait({ provider: "letterboxd", waitMs: 12_000 }, T, null);

  test("labels the wait from 3 s, in seconds then minutes", () => {
    assert.equal(queueLabel(wait, T), "In the Letterboxd queue · about 12 s");
    assert.equal(
      queueLabel(wait, T + 9_000),
      "In the Letterboxd queue · about 3 s",
    );
    assert.equal(queueLabel(wait, T + 9_500), null);
    assert.equal(queueLabel(null, T), null);
    const long = queueWait(
      { provider: "letterboxd", waitMs: 110_000 },
      T,
      null,
    );
    assert.equal(queueLabel(long, T), "In the Letterboxd queue · about 2 min");
  });

  test("words the Catalog preview", () => {
    const preview = queueWait(
      { provider: "letterboxd", waitMs: 40_000 },
      T,
      null,
    );
    assert.equal(
      previewQueueMessage(preview, T),
      "Letterboxd is busy right now. Your list is in the queue, about 40 s left.",
    );
    // The estimate counts down, never below 1 s.
    assert.match(
      previewQueueMessage(preview, T + 45_000),
      /about 1 s left\.$/u,
    );
  });

  test("keeps the start of the wait across answers, so the bar only moves on", () => {
    const later = queueWait(
      { provider: "letterboxd", waitMs: 30_000 },
      T + 10_000,
      wait,
    );
    assert.equal(later.since, T);
    assert.equal(queueProgress(later, T + 10_000), 0.25);
    assert.equal(queueProgress(later, T + 100_000), 0.95);
    assert.equal(queueProgress(wait, T - 1), 0);
  });

  test("asks again within bounds", () => {
    assert.equal(retryDelay(0), 250);
    assert.equal(retryDelay(4_000), 4_000);
    assert.equal(retryDelay(60_000), 15_000);
  });

  test("uses no dash in the copy", () => {
    assert.doesNotMatch(
      `${queueLabel(wait, T)} ${previewQueueMessage(wait, T)}`,
      /[–—]/u,
    );
  });
});
