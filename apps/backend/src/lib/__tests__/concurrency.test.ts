import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("keeps the input order and never runs more than the limit", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      [30, 10, 20, 0, 5],
      2,
      async (delay, index) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, delay));
        running -= 1;
        return `${index}:${delay}`;
      },
    );
    expect(results).toEqual(["0:30", "1:10", "2:20", "3:0", "4:5"]);
    expect(peak).toBe(2);
  });

  it("returns an empty array for no items", async () => {
    await expect(
      mapWithConcurrency([], 3, () => Promise.resolve(1)),
    ).resolves.toEqual([]);
  });
});
