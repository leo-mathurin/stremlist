import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});

import { fakeAdapter } from "../../__tests__/helpers/mock-registry";
import { db } from "../../__tests__/helpers/mock-supabase";
import type { ResolverStrategy, SourceEntry } from "../../providers/types";
import { resolveEntries } from "../resolver";

const DAY = 24 * 60 * 60_000;

function tmdb(id: number): SourceEntry {
  return { externalIds: { tmdb: { id, type: "movie" } }, type: "movie" };
}

/** A strategy that knows a fixed TMDB ID → IMDb ID table. */
function strategy(
  name: string,
  known: Record<number, string>,
): ResolverStrategy & { resolve: ReturnType<typeof vi.fn> } {
  return {
    name,
    resolve: vi.fn((entries: SourceEntry[]) =>
      Promise.resolve(
        new Map(
          entries.flatMap((entry, index): [number, string][] => {
            const imdbId = known[entry.externalIds?.tmdb?.id ?? -1];
            return imdbId ? [[index, imdbId]] : [];
          }),
        ),
      ),
    ),
  };
}

function adapter(strategies: ResolverStrategy[]) {
  return fakeAdapter("trakt", {
    resolutionKey: (entry) =>
      entry.externalIds?.tmdb
        ? {
            namespace: `tmdb:${entry.externalIds.tmdb.type}`,
            externalId: String(entry.externalIds.tmdb.id),
          }
        : null,
    resolverStrategies: strategies,
  });
}

function cacheRow(externalId: string) {
  return db
    .getTable("title_id_map")
    .find((row) => row.external_id === externalId);
}

beforeEach(() => {
  db.reset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("resolveEntries", () => {
  it("passes entries with an IMDb ID through without the cache or strategies", async () => {
    const first = strategy("first", {});
    const entries: SourceEntry[] = [
      { imdbId: "tt0111161" },
      { imdbId: "tt0068646" },
    ];

    const result = await resolveEntries(adapter([first]), entries);

    expect(result).toEqual({
      resolved: [
        { imdbId: "tt0111161", entry: entries[0] },
        { imdbId: "tt0068646", entry: entries[1] },
      ],
      unresolved: 0,
      deferred: 0,
    });
    expect(first.resolve).not.toHaveBeenCalled();
    expect(db.getTable("title_id_map")).toEqual([]);
  });

  it("does not trust a malformed IMDb ID", async () => {
    const result = await resolveEntries(adapter([]), [
      { imdbId: "nm0000123" },
      { imdbId: "tt12abc" },
    ]);

    expect(result).toEqual({ resolved: [], unresolved: 2, deferred: 0 });
  });

  it("counts entries without a resolution key as unresolved", async () => {
    const result = await resolveEntries(adapter([strategy("s", {})]), [
      { title: "No IDs at all" },
    ]);

    expect(result.unresolved).toBe(1);
    expect(db.getTable("title_id_map")).toEqual([]);
  });

  it("uses the cache before any strategy", async () => {
    db.insert("title_id_map", {
      namespace: "tmdb:movie",
      external_id: "550",
      imdb_id: "tt0137523",
      strategy: "first",
    });
    const first = strategy("first", { 550: "tt9999999" });

    const result = await resolveEntries(adapter([first]), [tmdb(550)]);

    expect(result.resolved.map((item) => item.imdbId)).toEqual(["tt0137523"]);
    expect(first.resolve).not.toHaveBeenCalled();
  });

  it("runs strategies in order and gives each only what is still unresolved", async () => {
    const first = strategy("first", { 1: "tt0000001", 3: "tt0000003" });
    const second = strategy("second", { 2: "tt0000002", 3: "tt9999999" });
    const third = strategy("third", {});
    const entries = [tmdb(1), tmdb(2), tmdb(3), { imdbId: "tt0000004" }];

    const result = await resolveEntries(
      adapter([first, second, third]),
      entries,
    );

    expect(result.resolved.map((item) => item.imdbId)).toEqual([
      "tt0000001",
      "tt0000002",
      "tt0000003",
      "tt0000004",
    ]);
    expect(first.resolve).toHaveBeenCalledWith([tmdb(1), tmdb(2), tmdb(3)]);
    expect(second.resolve).toHaveBeenCalledWith([tmdb(2)]);
    // Everything is resolved: later strategies do not run.
    expect(third.resolve).not.toHaveBeenCalled();
    expect(cacheRow("1")).toMatchObject({
      imdb_id: "tt0000001",
      strategy: "first",
    });
    expect(cacheRow("2")).toMatchObject({
      imdb_id: "tt0000002",
      strategy: "second",
    });
  });

  it("keeps going when a strategy throws", async () => {
    const broken: ResolverStrategy = {
      name: "broken",
      resolve: () => Promise.reject(new Error("TMDB down")),
    };
    const backup = strategy("backup", { 1: "tt0000001" });

    const result = await resolveEntries(adapter([broken, backup]), [tmdb(1)]);

    expect(result.resolved.map((item) => item.imdbId)).toEqual(["tt0000001"]);
  });

  it("ignores a strategy answer that is not an IMDb ID", async () => {
    const bad = strategy("bad", { 1: "tmdb:1" });

    const result = await resolveEntries(adapter([bad]), [tmdb(1)]);

    expect(result.unresolved).toBe(1);
    expect(cacheRow("1")).toMatchObject({ imdb_id: null });
  });

  it("remembers unresolved entries with a retry time instead of a permanent failure", async () => {
    const first = strategy("first", {});

    const result = await resolveEntries(adapter([first]), [tmdb(7)]);

    expect(result).toEqual({ resolved: [], unresolved: 1, deferred: 0 });
    const row = cacheRow("7");
    expect(row).toMatchObject({ imdb_id: null, strategy: null });
    const wait = Date.parse(row?.retry_after as string) - Date.now();
    expect(wait).toBeGreaterThan(DAY - 60_000);
    expect(wait).toBeLessThanOrEqual(DAY);
  });

  it("does not retry an unresolved entry before its retry time", async () => {
    db.insert("title_id_map", {
      namespace: "tmdb:movie",
      external_id: "7",
      imdb_id: null,
      retry_after: new Date(Date.now() + DAY).toISOString(),
    });
    const first = strategy("first", { 7: "tt0000007" });

    const result = await resolveEntries(adapter([first]), [tmdb(7)]);

    expect(result.unresolved).toBe(1);
    expect(first.resolve).not.toHaveBeenCalled();
  });

  it("retries an unresolved entry after its retry time and caches the new answer", async () => {
    db.insert("title_id_map", {
      namespace: "tmdb:movie",
      external_id: "7",
      imdb_id: null,
      retry_after: new Date(Date.now() - 1000).toISOString(),
    });
    const first = strategy("first", { 7: "tt0000007" });

    const result = await resolveEntries(adapter([first]), [tmdb(7)]);

    expect(result.resolved.map((item) => item.imdbId)).toEqual(["tt0000007"]);
    expect(cacheRow("7")).toMatchObject({
      imdb_id: "tt0000007",
      retry_after: null,
      strategy: "first",
    });
  });

  it("sends at most 300 entries through the strategies per refresh", async () => {
    const entries = Array.from({ length: 350 }, (_, index) => tmdb(index + 1));
    const all = Object.fromEntries(
      entries.map((_, index) => [
        index + 1,
        `tt${String(index + 1).padStart(7, "0")}`,
      ]),
    );
    const first = strategy("first", all);

    const firstRun = await resolveEntries(adapter([first]), entries);

    // Chunks of 50, so a slow strategy can stop at the time budget.
    const sent = first.resolve.mock.calls.map(
      (call) => (call[0] as SourceEntry[]).length,
    );
    expect(sent).toEqual([50, 50, 50, 50, 50, 50]);
    expect(firstRun.resolved).toHaveLength(300);
    expect(firstRun.unresolved).toBe(50);
    expect(firstRun.deferred).toBe(50);
    // Entries over the cap are not marked as failures: the next refresh
    // resolves them right away.
    expect(cacheRow("301")).toBeUndefined();

    first.resolve.mockClear();
    const secondRun = await resolveEntries(adapter([first]), entries);

    expect(
      first.resolve.mock.calls.map((call) => (call[0] as SourceEntry[]).length),
    ).toEqual([50]);
    expect(secondRun.unresolved).toBe(0);
    expect(secondRun.deferred).toBe(0);
  });

  it("stops starting chunks once the time budget is spent", async () => {
    const entries = Array.from({ length: 120 }, (_, index) => tmdb(index + 1));
    const known = strategy(
      "slow",
      Object.fromEntries(
        entries.map((_, index) => [
          index + 1,
          `tt${String(index + 1).padStart(7, "0")}`,
        ]),
      ),
    );
    const slow = {
      name: "slow",
      resolve: vi.fn(async (batch: SourceEntry[]) => {
        await new Promise((done) => setTimeout(done, 15));
        return known.resolve(batch);
      }),
    };

    const result = await resolveEntries(adapter([slow]), entries, {
      budgetMs: 10,
    });

    // The first chunk always runs; the budget stops the next ones.
    expect(slow.resolve).toHaveBeenCalledOnce();
    expect(result.resolved).toHaveLength(50);
    expect(result.deferred).toBe(70);
    // Untried entries leave no cache row, so they are not delayed a day.
    expect(cacheRow("51")).toBeUndefined();
  });

  it("caches a Title that appears twice in the same Source list", async () => {
    const first = strategy("first", { 550: "tt0137523" });

    const result = await resolveEntries(adapter([first]), [
      tmdb(550),
      tmdb(550),
    ]);

    expect(result.resolved.map((item) => item.imdbId)).toEqual([
      "tt0137523",
      "tt0137523",
    ]);
    expect(cacheRow("550")).toMatchObject({ imdb_id: "tt0137523" });

    // The next refresh finds it in the cache.
    await resolveEntries(adapter([first]), [tmdb(550), tmdb(550)]);
    expect(first.resolve).toHaveBeenCalledOnce();
  });

  it("keeps the order of the Source list", async () => {
    db.insert("title_id_map", {
      namespace: "tmdb:movie",
      external_id: "2",
      imdb_id: "tt0000002",
    });
    const first = strategy("first", { 1: "tt0000001", 3: "tt0000003" });

    const result = await resolveEntries(adapter([first]), [
      tmdb(3),
      tmdb(2),
      { imdbId: "tt0000009" },
      tmdb(1),
    ]);

    expect(result.resolved.map((item) => item.imdbId)).toEqual([
      "tt0000003",
      "tt0000002",
      "tt0000009",
      "tt0000001",
    ]);
  });
});
