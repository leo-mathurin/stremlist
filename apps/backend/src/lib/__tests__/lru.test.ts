import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LruCache } from "../lru";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

const weighted = () =>
  new LruCache<string, string>({ maxEntries: 10, maxWeight: 100 });

describe("LruCache", () => {
  it("drops the least recently used entry past the entry limit", () => {
    const cache = new LruCache<string, number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    // Reading "a" makes "b" the least recently used.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.get("b")).toBeUndefined();
  });

  it("drops the least recently used entries past the weight limit", () => {
    const cache = weighted();
    cache.set("a", "a", { weight: 40 });
    cache.set("b", "b", { weight: 40 });
    cache.set("c", "c", { weight: 40 });

    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.weight).toBe(80);
  });

  it("does not keep an entry heavier than the whole budget", () => {
    const cache = weighted();
    cache.set("small", "s", { weight: 10 });
    cache.set("huge", "h", { weight: 101 });

    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("small")).toBe("s");
    expect(cache.weight).toBe(10);
  });

  it("counts the new weight when an entry is replaced", () => {
    const cache = weighted();
    cache.set("a", "first", { weight: 60 });
    cache.set("a", "second", { weight: 30 });

    expect(cache.get("a")).toBe("second");
    expect(cache.weight).toBe(30);
  });

  it("expires entries after their time to live", () => {
    const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("short", 2, { ttlMs: 100 });

    vi.setSystemTime(100);
    expect(cache.has("short")).toBe(false);
    expect(cache.get("a")).toBe(1);

    vi.setSystemTime(1000);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("frees expired entries on the next write, even unread ones", () => {
    const cache = new LruCache<string, string>({
      maxEntries: 10,
      maxWeight: 1000,
      ttlMs: 1000,
    });
    cache.set("old", "o", { weight: 500 });

    vi.setSystemTime(1000);
    cache.set("new", "n", { weight: 10 });

    expect(cache.keys()).toEqual(["new"]);
    expect(cache.weight).toBe(10);
  });

  it("keeps null values apart from missing ones", () => {
    const cache = new LruCache<string, string | null>({ maxEntries: 10 });
    cache.set("none", null);

    expect(cache.get("none")).toBeNull();
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("none")).toBe(true);
  });

  it("forgets everything on clear", () => {
    const cache = weighted();
    cache.set("a", "a", { weight: 50 });
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });
});
