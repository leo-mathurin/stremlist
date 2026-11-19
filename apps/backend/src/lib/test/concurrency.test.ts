import { describe, expect, it } from "vite-plus/test";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("keeps the input order and never runs more than the limit", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const started = items.map(() => Promise.withResolvers<void>());
    const finish = items.map(() => Promise.withResolvers<void>());
    const startOrder: number[] = [];
    let running = 0;
    let peak = 0;
    const results = mapWithConcurrency(items, 2, async (item, index) => {
      running += 1;
      peak = Math.max(peak, running);
      startOrder.push(index);
      started[index].resolve();
      await finish[index].promise;
      running -= 1;
      return `${index}:${item}`;
    });

    await Promise.all([started[0].promise, started[1].promise]);
    expect(startOrder).toEqual([0, 1]);
    finish[1].resolve();
    await started[2].promise;
    expect(startOrder).toEqual([0, 1, 2]);
    finish[0].resolve();
    await started[3].promise;
    finish[3].resolve();
    await started[4].promise;
    expect(startOrder).toEqual([0, 1, 2, 3, 4]);
    finish[4].resolve();
    finish[2].resolve();

    await expect(results).resolves.toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    expect(peak).toBe(2);
  });

  it("returns an empty array for no items", async () => {
    await expect(
      mapWithConcurrency([], 3, () => Promise.resolve(1)),
    ).resolves.toEqual([]);
  });
});
