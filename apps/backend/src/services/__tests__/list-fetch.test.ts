import type { StremioMeta, CatalogData } from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scraperMocks = vi.hoisted(() => ({
  fetchChart: vi.fn(),
  fetchList: vi.fn(),
  fetchWatchlist: vi.fn(),
  fetchTitlesByIds: vi.fn(),
}));

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});
vi.mock("../imdb-scraper", () => ({
  ...scraperMocks,
  buildPosterUrl: vi.fn((_id: string, poster: string | null) => poster),
  classifyImdbError: vi.fn(() => null),
  isListId: vi.fn((id: string) => id.startsWith("ls")),
}));
vi.mock("../list-cache", async () => {
  const cache = await import("../../__tests__/helpers/mock-list-cache");
  return {
    ...cache,
    getCachedList: vi.fn(cache.getCachedList),
    writeCachedList: vi.fn(cache.writeCachedList),
  };
});
vi.mock("../../providers/registry", async () => {
  return await import("../../__tests__/helpers/mock-registry");
});

import { seedAccount, seedConnection } from "../../__tests__/helpers/fixtures";
import { cache } from "../../__tests__/helpers/mock-list-cache";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import { db, resetRpc } from "../../__tests__/helpers/mock-supabase";
import type { SourceEntry } from "../../providers/types";
import * as listCache from "../list-cache";
import type { ListFetchConfig } from "../lists";
import { getListCatalog, ListUnavailableError } from "../lists";

const LIST_ID = "22222222-2222-4222-8222-222222222222";

const MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};

function meta(id: string, overrides: Partial<StremioMeta> = {}): StremioMeta {
  return { ...MOVIE, id, name: `Title ${id}`, ...overrides };
}

function config(overrides: Partial<ListFetchConfig> = {}): ListFetchConfig {
  return {
    accountId: "sl_0000000000000000000000",
    listId: LIST_ID,
    provider: "imdb",
    sourceRef: "ls123456789",
    sort: { by: "added_at", order: "asc" },
    allowConnection: false,
    skipAccountTimestamp: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  scraperMocks.fetchTitlesByIds.mockResolvedValue(new Map());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getListCatalog", () => {
  it("coalesces concurrent cache misses for the same Source list", async () => {
    const releaseFetches: ((data: CatalogData) => void)[] = [];
    scraperMocks.fetchList.mockImplementation(
      () =>
        new Promise<CatalogData>((resolve) => {
          releaseFetches.push(resolve);
        }),
    );

    const first = getListCatalog(config());
    const second = getListCatalog(config());

    await vi.waitFor(() => {
      expect(listCache.getCachedList).toHaveBeenCalledTimes(2);
      expect(scraperMocks.fetchList).toHaveBeenCalled();
    });
    releaseFetches.forEach((release) => {
      release({ metas: [MOVIE] });
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { metas: [MOVIE] },
      { metas: [MOVIE] },
    ]);
    expect(scraperMocks.fetchList).toHaveBeenCalledOnce();
    expect(listCache.writeCachedList).toHaveBeenCalledOnce();
  });

  it("does not share a read between a Connection request and a public one", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({ entries: [{ imdbId: MOVIE.id, meta: MOVIE }] }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    const base = config({
      accountId: account.id,
      provider: "trakt",
      sourceRef: "users/leo/watchlist",
    });

    await Promise.all([
      getListCatalog({ ...base, allowConnection: true }),
      getListCatalog({ ...base, allowConnection: false }),
    ]);

    expect(fetchSource).toHaveBeenCalledTimes(2);
    expect(fetchSource).toHaveBeenCalledWith("users/leo/watchlist", {
      connection: null,
    });
    expect(fetchSource).toHaveBeenCalledWith("users/leo/watchlist", {
      connection: expect.objectContaining({ provider: "trakt" }) as unknown,
    });
  });

  it("serves a fresh non-empty cache without reading the Provider", async () => {
    cache.seed(LIST_ID, [MOVIE]);

    await expect(getListCatalog(config())).resolves.toEqual({
      metas: [MOVIE],
    });
    expect(scraperMocks.fetchList).not.toHaveBeenCalled();
  });

  it("reads the Provider again once the cache is older than its freshness", async () => {
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));
    scraperMocks.fetchList.mockResolvedValue({ metas: [meta("tt0000002")] });

    const result = await getListCatalog(config());

    expect(result.metas.map((item) => item.id)).toEqual(["tt0000002"]);
    expect(cache.get(LIST_ID)?.data.metas.map((item) => item.id)).toEqual([
      "tt0000002",
    ]);
  });

  it("updates last_fetched_at after a Provider read unless asked not to", async () => {
    const account = seedAccount({ last_fetched_at: new Date(0).toISOString() });
    scraperMocks.fetchList.mockResolvedValue({ metas: [MOVIE] });

    await getListCatalog(
      config({ accountId: account.id, skipAccountTimestamp: false }),
    );

    expect(db.getTable("accounts")[0].last_fetched_at).not.toBe(
      new Date(0).toISOString(),
    );
  });
});

describe("Provider pipeline: resolve, enrich, cache", () => {
  it("resolves and enriches the entries of an adapter that only returns IDs", async () => {
    const entries: SourceEntry[] = [
      { imdbId: "tt0000001", type: "movie" },
      { externalIds: { tmdb: { id: 550, type: "movie" } }, type: "movie" },
      { externalIds: { tmdb: { id: 999, type: "movie" } }, type: "movie" },
      // A second copy of a Title is shown once.
      { imdbId: "tt0000001", type: "movie" },
    ];
    const strategy = vi.fn((pending: SourceEntry[]) =>
      Promise.resolve(
        new Map(
          pending.flatMap((entry, index): [number, string][] =>
            entry.externalIds?.tmdb?.id === 550 ? [[index, "tt0137523"]] : [],
          ),
        ),
      ),
    );
    useFakeProvider(
      fakeAdapter("trakt", {
        entries,
        resolutionKey: (entry) =>
          entry.externalIds?.tmdb
            ? {
                namespace: `tmdb:${entry.externalIds.tmdb.type}`,
                externalId: String(entry.externalIds.tmdb.id),
              }
            : null,
        resolverStrategies: [{ name: "tmdb", resolve: strategy }],
      }),
    );
    scraperMocks.fetchTitlesByIds.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, meta(id)]))),
    );

    const result = await getListCatalog(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    );

    expect(result.metas.map((item) => item.id)).toEqual([
      "tt0000001",
      "tt0137523",
    ]);
    expect(scraperMocks.fetchTitlesByIds).toHaveBeenCalledOnce();
    expect(scraperMocks.fetchTitlesByIds).toHaveBeenCalledWith([
      "tt0000001",
      "tt0137523",
    ]);
    // The unresolved entry is remembered for a later retry, not dropped.
    expect(db.getTable("title_id_map")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "tmdb:movie",
          external_id: "550",
          imdb_id: "tt0137523",
        }),
        expect.objectContaining({
          namespace: "tmdb:movie",
          external_id: "999",
          imdb_id: null,
        }),
      ]),
    );
    expect(cache.get(LIST_ID)?.data.metas).toHaveLength(2);
  });

  it("asks for a new read soon when the resolver left entries untried", async () => {
    // 350 entries without an IMDb ID: the resolver tries 300 per read.
    // IDs from 5000 up: enrichment keeps an in-memory cache between tests.
    const entries: SourceEntry[] = Array.from({ length: 350 }, (_, index) => ({
      externalIds: { tmdb: { id: 5000 + index, type: "movie" } },
      type: "movie",
    }));
    useFakeProvider(
      fakeAdapter("senscritique", {
        entries,
        freshnessMs: 6 * 60 * 60_000,
        resolutionKey: (entry) => ({
          namespace: "test",
          externalId: String(entry.externalIds?.tmdb?.id),
        }),
        resolverStrategies: [
          {
            name: "all",
            resolve: (pending) =>
              Promise.resolve(
                new Map(
                  pending.map((entry, index): [number, string] => [
                    index,
                    `tt${String(entry.externalIds?.tmdb?.id).padStart(7, "0")}`,
                  ]),
                ),
              ),
          },
        ],
      }),
    );
    scraperMocks.fetchTitlesByIds.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, meta(id)]))),
    );

    await getListCatalog(
      config({ provider: "senscritique", sourceRef: "users/leo/wishes" }),
    );

    // Stored as if it went stale two minutes from now, not in six hours.
    const storedAt = cache.get(LIST_ID)?.cachedAt.getTime() ?? 0;
    const staleIn = storedAt + 6 * 60 * 60_000 - Date.now();
    expect(staleIn).toBeGreaterThan(60_000);
    expect(staleIn).toBeLessThanOrEqual(2 * 60_000);
    expect(cache.get(LIST_ID)?.data.metas).toHaveLength(300);
  });

  it("reuses metadata from the previous cache generation", async () => {
    const cachedAt = new Date(Date.now() - 2 * 60 * 60_000);
    cache.seed(LIST_ID, [meta("tt0000001", { name: "Cached" })], cachedAt);
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [{ imdbId: "tt0000001" }, { imdbId: "tt0000002" }],
      }),
    );
    scraperMocks.fetchTitlesByIds.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, meta(id)]))),
    );

    const result = await getListCatalog(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    );

    expect(result.metas.map((item) => item.name)).toEqual([
      "Cached",
      "Title tt0000002",
    ]);
    expect(scraperMocks.fetchTitlesByIds).toHaveBeenCalledWith(["tt0000002"]);
  });

  it("links each item back to its page on the Provider, once", async () => {
    // Generic: any adapter may set sourceUrl (Simkl does, as its terms ask).
    const url = "https://trakt.tv/movies/the-shawshank-redemption-1994";
    const cachedAt = new Date(Date.now() - 2 * 60 * 60_000);
    // The previous cache generation already has the line.
    cache.seed(
      LIST_ID,
      [
        meta("tt0000001", {
          description: `A banker.\n\nMore on Trakt: ${url}`,
        }),
      ],
      cachedAt,
    );
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [
          { imdbId: "tt0000001", sourceUrl: url },
          { imdbId: "tt0000002", sourceUrl: `${url}-2` },
          { imdbId: "tt0000003" },
        ],
      }),
    );
    scraperMocks.fetchTitlesByIds.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, meta(id)]))),
    );

    const result = await getListCatalog(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    );

    expect(result.metas.map((item) => item.description)).toEqual([
      `A banker.\n\nMore on Trakt: ${url}`,
      `More on Trakt: ${url}-2`,
      "",
    ]);
  });

  it("answers `disabled` when the Provider is turned off and nothing is cached", async () => {
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    process.env.DISABLED_PROVIDERS = "trakt";

    const error = await getListCatalog(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ListUnavailableError);
    expect(error).toMatchObject({ reason: "disabled", provider: "trakt" });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("answers `needs_connection` for a Connection list read through a Legacy alias", async () => {
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    const account = seedAccount();
    seedConnection(account.id, "trakt");

    const error = await getListCatalog(
      config({
        accountId: account.id,
        provider: "trakt",
        sourceRef: "me/watchlist",
        allowConnection: false,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "needs_connection" });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("answers `needs_connection` when a private Account has no Connection", async () => {
    useFakeProvider(fakeAdapter("simkl"));
    const account = seedAccount();

    const error = await getListCatalog(
      config({
        accountId: account.id,
        provider: "simkl",
        sourceRef: "me/plantowatch",
        allowConnection: true,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "needs_connection" });
  });

  it("does not serve the cache of a List whose Connection is gone", async () => {
    useFakeProvider(fakeAdapter("simkl"));
    const account = seedAccount();
    // Cached while connected, and stale now.
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));

    const error = await getListCatalog(
      config({
        accountId: account.id,
        provider: "simkl",
        sourceRef: "me/plantowatch",
        allowConnection: true,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "needs_connection" });
  });

  it("reports an honest failure when asked not to fall back on the cache", async () => {
    cache.seed(LIST_ID, [MOVIE], new Date(0));
    scraperMocks.fetchList.mockRejectedValue(new Error("boom"));

    await expect(
      getListCatalog(config({ forceFresh: true, noCacheFallback: true })),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await expect(getListCatalog(config())).resolves.toEqual({
      metas: [MOVIE],
    });
  });
});
