import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { traktProvider } from "../../providers/trakt";
import type {
  ProviderAdapter,
  ResolverStrategy,
  SourceEntry,
} from "../../providers/types";
import { db, resetRpc } from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { resolveEntries } from "../resolver";

useMswServer();

const DAY = 24 * 60 * 60_000;

function tmdb(id: number) {
  const entry: SourceEntry = {
    externalIds: { tmdb: { id, type: "movie" } },
    type: "movie",
  };
  return entry;
}

function strategy(name: string, known: Record<number, string>) {
  const calls: SourceEntry[][] = [];
  return {
    name,
    calls,
    resolve(entries: SourceEntry[]) {
      calls.push(entries);
      return Promise.resolve(
        new Map(
          entries.flatMap((entry, index) => {
            const imdbId = known[entry.externalIds?.tmdb?.id ?? -1];
            return imdbId ? [[index, imdbId] as const] : [];
          }),
        ),
      );
    },
  } satisfies ResolverStrategy & { calls: SourceEntry[][] };
}

function adapter(strategies: ResolverStrategy[]) {
  const value: ProviderAdapter = {
    ...traktProvider,
    resolutionKey: (entry) =>
      entry.externalIds?.tmdb
        ? {
            namespace: `tmdb:${entry.externalIds.tmdb.type}`,
            externalId: String(entry.externalIds.tmdb.id),
          }
        : null,
    resolverStrategies: strategies,
  };
  return value;
}

const tt = (n: number) => `tt${String(n).padStart(7, "0")}`;

function knowing(entries: SourceEntry[]) {
  return Object.fromEntries(
    entries.map((_, index) => [index + 1, tt(index + 1)]),
  );
}

function imdbIds(result: Awaited<ReturnType<typeof resolveEntries>>) {
  return result.resolved.map(({ imdbId }) => imdbId);
}

function seedCache(externalId: string, row: Record<string, unknown>) {
  db.insert("title_id_map", {
    namespace: "tmdb:movie",
    external_id: externalId,
    ...row,
  });
}

function cacheRow(externalId: string) {
  return db
    .getTable("title_id_map")
    .find((row) => row.external_id === externalId);
}

beforeEach(() => {
  db.reset();
  resetRpc();
  vi.spyOn(console, "error");
});

describe("resolveEntries", () => {
  it("keeps bulk lookups grouped and paced lookups outside the budget deferred", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slow: ResolverStrategy = {
        name: "paced-film-links",
        batchSize: 2,
        resolve: (batch: SourceEntry[]) => {
          vi.setSystemTime(Date.now() + batch.length * 3000);
          return Promise.resolve(new Map<number, string>());
        },
      };
      const bulk = strategy("bulk", {});
      const paced = adapter([bulk, slow]);
      const started = Date.now();
      const result = await resolveEntries(
        paced,
        Array.from({ length: 50 }, (_, index) => tmdb(index + 1)),
        { budgetMs: 10_000 },
      );
      expect(Date.now() - started).toBe(12_000);
      expect(result.deferred).toBe(46);
      expect(bulk.calls).toHaveLength(1);
      expect(bulk.calls[0]).toHaveLength(50);
      expect(db.getTable("title_id_map")).toHaveLength(4);
      expect(cacheRow("5")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("skips a strategy whose Provider kill switch is on", async () => {
    process.env.DISABLED_PROVIDERS = "justwatch";
    try {
      const justwatch = {
        ...strategy("justwatch", { 1: "tt0111161" }),
        provider: "justwatch" as const,
      };
      const tmdbOnly = strategy("tmdb", { 2: "tt0068646" });

      const result = await resolveEntries(adapter([justwatch, tmdbOnly]), [
        tmdb(1),
        tmdb(2),
      ]);

      expect(justwatch.calls).toEqual([]);
      expect(imdbIds(result)).toEqual(["tt0068646"]);
      expect(result.unresolvedEntries).toHaveLength(1);
    } finally {
      delete process.env.DISABLED_PROVIDERS;
    }
  });

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
      unresolvedEntries: [],
      deferred: 0,
    });
    expect(first.calls).toEqual([]);
    expect(db.getTable("title_id_map")).toEqual([]);
  });

  it("does not trust a malformed IMDb ID", async () => {
    const entries: SourceEntry[] = [
      { imdbId: "nm0000123" },
      { imdbId: "tt12abc" },
    ];
    const result = await resolveEntries(adapter([]), entries);

    expect(result).toEqual({
      resolved: [],
      unresolvedEntries: entries,
      deferred: 0,
    });
  });

  it("counts entries without a resolution key as unresolved", async () => {
    const result = await resolveEntries(adapter([strategy("s", {})]), [
      { title: "No IDs at all" },
    ]);

    expect(result.unresolvedEntries).toEqual([{ title: "No IDs at all" }]);
    expect(db.getTable("title_id_map")).toEqual([]);
  });

  it("returns the Unresolved entries in Source list order", async () => {
    const entries = [tmdb(1), tmdb(2), { title: "No IDs" }, tmdb(3)];
    const result = await resolveEntries(
      adapter([strategy("s", { 2: "tt0068646" })]),
      entries,
    );

    expect(imdbIds(result)).toEqual(["tt0068646"]);
    expect(result.unresolvedEntries).toEqual([
      entries[0],
      entries[2],
      entries[3],
    ]);
  });

  it("uses the cache before any strategy", async () => {
    seedCache("550", { imdb_id: "tt0137523", strategy: "first" });
    const first = strategy("first", { 550: "tt9999999" });

    const result = await resolveEntries(adapter([first]), [tmdb(550)]);

    expect(imdbIds(result)).toEqual(["tt0137523"]);
    expect(first.calls).toEqual([]);
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

    expect(imdbIds(result)).toEqual([
      "tt0000001",
      "tt0000002",
      "tt0000003",
      "tt0000004",
    ]);
    expect(first.calls).toEqual([[tmdb(1), tmdb(2), tmdb(3)]]);
    expect(second.calls).toEqual([[tmdb(2)]]);
    expect(third.calls).toEqual([]);
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

    expect(imdbIds(result)).toEqual(["tt0000001"]);
  });

  it("ignores a strategy answer that is not an IMDb ID", async () => {
    const bad = strategy("bad", { 1: "tmdb:1" });

    const result = await resolveEntries(adapter([bad]), [tmdb(1)]);

    expect(result.unresolvedEntries).toHaveLength(1);
    expect(cacheRow("1")).toMatchObject({ imdb_id: null });
  });

  it("remembers unresolved entries with a retry time instead of a permanent failure", async () => {
    const first = strategy("first", {});

    const result = await resolveEntries(adapter([first]), [tmdb(7)]);

    expect(result).toEqual({
      resolved: [],
      unresolvedEntries: [tmdb(7)],
      deferred: 0,
    });
    const row = cacheRow("7");
    expect(row).toMatchObject({ imdb_id: null, strategy: null });
    const retryAfter = row?.retry_after;
    if (typeof retryAfter !== "string") throw new Error("no retry time");
    const wait = Date.parse(retryAfter) - Date.now();
    expect(wait).toBeGreaterThan(DAY - 60_000);
    expect(wait).toBeLessThanOrEqual(DAY);
  });

  it("does not retry an unresolved entry before its retry time", async () => {
    seedCache("7", {
      imdb_id: null,
      retry_after: new Date(Date.now() + DAY).toISOString(),
    });
    const first = strategy("first", { 7: "tt0000007" });

    const result = await resolveEntries(adapter([first]), [tmdb(7)]);

    expect(result.unresolvedEntries).toHaveLength(1);
    expect(first.calls).toEqual([]);
  });

  it("retries an unresolved entry after its retry time and caches the new answer", async () => {
    seedCache("7", {
      imdb_id: null,
      retry_after: new Date(Date.now() - 1000).toISOString(),
    });
    const first = strategy("first", { 7: "tt0000007" });

    const result = await resolveEntries(adapter([first]), [tmdb(7)]);

    expect(imdbIds(result)).toEqual(["tt0000007"]);
    expect(cacheRow("7")).toMatchObject({
      imdb_id: "tt0000007",
      retry_after: null,
      strategy: "first",
    });
  });

  it("sends at most 300 entries through the strategies per refresh", async () => {
    const entries = Array.from({ length: 350 }, (_, index) => tmdb(index + 1));
    const first = strategy("first", knowing(entries));

    const firstRun = await resolveEntries(adapter([first]), entries);

    const sent = () => first.calls.map((batch) => batch.length);
    expect(sent()).toEqual([50, 50, 50, 50, 50, 50]);
    expect(firstRun.resolved).toHaveLength(300);
    expect(firstRun.unresolvedEntries).toHaveLength(50);
    expect(firstRun.deferred).toBe(50);
    expect(cacheRow("301")).toBeUndefined();

    first.calls.length = 0;
    const secondRun = await resolveEntries(adapter([first]), entries);

    expect(sent()).toEqual([50]);
    expect(secondRun.unresolvedEntries).toHaveLength(0);
    expect(secondRun.deferred).toBe(0);
  });

  it("stops starting chunks once the time budget is spent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const entries = Array.from({ length: 120 }, (_, index) =>
        tmdb(index + 1),
      );
      const known = strategy("slow", knowing(entries));
      const slow: ResolverStrategy = {
        name: "slow",
        resolve(batch: SourceEntry[]) {
          vi.setSystemTime(Date.now() + 15);
          return known.resolve(batch);
        },
      };

      const result = await resolveEntries(adapter([slow]), entries, {
        budgetMs: 10,
      });

      expect(known.calls).toHaveLength(1);
      expect(result.resolved).toHaveLength(50);
      expect(result.deferred).toBe(70);
      expect(cacheRow("51")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a Title that appears twice in the same Source list", async () => {
    const first = strategy("first", { 550: "tt0137523" });

    const result = await resolveEntries(adapter([first]), [
      tmdb(550),
      tmdb(550),
    ]);

    expect(imdbIds(result)).toEqual(["tt0137523", "tt0137523"]);
    expect(cacheRow("550")).toMatchObject({ imdb_id: "tt0137523" });

    await resolveEntries(adapter([first]), [tmdb(550), tmdb(550)]);
    expect(first.calls).toHaveLength(1);
  });

  it("keeps the order of the Source list", async () => {
    seedCache("2", { imdb_id: "tt0000002" });
    const first = strategy("first", { 1: "tt0000001", 3: "tt0000003" });

    const result = await resolveEntries(adapter([first]), [
      tmdb(3),
      tmdb(2),
      { imdbId: "tt0000009" },
      tmdb(1),
    ]);

    expect(imdbIds(result)).toEqual([
      "tt0000003",
      "tt0000002",
      "tt0000009",
      "tt0000001",
    ]);
  });
});
