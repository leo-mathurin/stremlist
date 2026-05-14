import { describe, expect, it } from "vitest";
import { seededShuffle } from "../utils";

interface Item {
  id: string;
}

function makeItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tt${i.toString().padStart(7, "0")}`,
  }));
}

describe("seededShuffle", () => {
  it("is deterministic for identical inputs", () => {
    const a = makeItems(50);
    const b = makeItems(50);
    expect(seededShuffle(a)).toEqual(seededShuffle(b));
  });

  it("produces a permutation (no items lost or duplicated)", () => {
    const items = makeItems(200);
    const shuffled = seededShuffle(items);
    expect(shuffled).toHaveLength(items.length);
    expect(new Set(shuffled.map((i) => i.id))).toEqual(
      new Set(items.map((i) => i.id)),
    );
  });

  it("changes order when an item is added", () => {
    const a = makeItems(20);
    const b = [...a, { id: "tt9999999" }];
    const shuffledA = seededShuffle(a).map((i) => i.id);
    const shuffledB = seededShuffle(b)
      .map((i) => i.id)
      .filter((id) => id !== "tt9999999");
    expect(shuffledA).not.toEqual(shuffledB);
  });

  it("does not mutate the input array", () => {
    const items = makeItems(10);
    const before = items.map((i) => i.id);
    seededShuffle(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it("handles empty and single-item arrays", () => {
    expect(seededShuffle([])).toEqual([]);
    const one = [{ id: "tt0000001" }];
    expect(seededShuffle(one)).toEqual(one);
  });

  it("supports paginated slicing — every item appears exactly once across pages", () => {
    const items = makeItems(137);
    const shuffled = seededShuffle(items);
    const page1 = shuffled.slice(0, 100);
    const page2 = shuffled.slice(100, 200);
    expect(page1).toHaveLength(100);
    expect(page2).toHaveLength(37);
    const union = new Set([...page1, ...page2].map((i) => i.id));
    expect(union.size).toBe(137);
  });
});
