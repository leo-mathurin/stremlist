import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  seedAccount,
  seedConnection,
  seedList,
} from "../../test/helpers/account.fixture";
import { cache } from "../../test/helpers/mock-list-cache";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../test/helpers/mock-registry";
import { db, resetRpc } from "../../test/helpers/mock-supabase";
import { FakeImdb, IMDB_GRAPHQL } from "../../test/helpers/imdb.test-utils";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { currentReadPriority } from "../../providers/read-priority";
import type { SourceEntry, SourceSnapshot } from "../../providers/types";
import { SourceUnavailableError } from "../../providers/types";
import * as listCache from "../list-cache";
import type { ListRead } from "../lists";
import {
  getListCatalog,
  ListUnavailableError,
  disconnectProvider,
} from "../lists";

vi.mock("../../lib/r2", () => import("../../test/helpers/mock-r2"));

vi.mock("../../lib/supabase", async () => {
  return await import("../../test/helpers/mock-supabase");
});
vi.mock("../list-cache", async () => {
  const cache = await import("../../test/helpers/mock-list-cache");
  return {
    ...cache,
    getCachedList: vi.fn(cache.getCachedList),
    writeCachedList: vi.fn(cache.writeCachedList),
  };
});
vi.mock("../../providers/registry", async () => {
  return await import("../../test/helpers/mock-registry");
});

const LIST_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_REF = "ls123456789";

const imdb = new FakeImdb();
const server = useMswServer();

function imdbDown() {
  server.use(
    http.post(IMDB_GRAPHQL, () => new HttpResponse(null, { status: 503 })),
  );
}

function titleBatches() {
  return imdb.requestsOf("TitlesById").map(({ variables }) => variables.ids);
}

function serveTitles(ids: string[]) {
  for (const id of ids) imdb.titles.set(id, meta(id));
}

const MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};

function meta(id: string, overrides: Partial<StremioMeta> = {}) {
  const value: StremioMeta = {
    ...MOVIE,
    id,
    name: `Title ${id}`,
    ...overrides,
  };
  return value;
}

interface TestRead extends ListRead {
  listId: string;
  provider: ProviderId;
  sourceRef: string;
  mergedSources?: ListSource[];
}

function readList({
  listId,
  provider,
  sourceRef,
  mergedSources,
  ...read
}: TestRead) {
  return getListCatalog(
    { id: listId, provider, sourceRef, mergedSources },
    read,
  );
}

function config(overrides: Partial<TestRead> = {}) {
  const read: TestRead = {
    accountId: "sl_0000000000000000000000",
    listId: LIST_ID,
    provider: "imdb",
    sourceRef: SOURCE_REF,
    sort: { by: "added_at", order: "asc" },
    allowConnection: false,
    policy: "catalog",
    ...overrides,
  };
  return read;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  imdb.reset();
  server.use(imdb.handler);
});

describe("getListCatalog", () => {
  it.each(["catalog", "prewarm"] as const)(
    "manual refresh waits for a pending %s write and then revalidates",
    async (policy) => {
      const blocked = Promise.withResolvers<void>();
      const writing = Promise.withResolvers<void>();
      const release = () => {
        blocked.resolve();
      };
      cache.beforeWrite = () => {
        cache.beforeWrite = null;
        writing.resolve();
        return blocked.promise;
      };
      const fresh = meta("tt0068646");
      const fetchSource = vi.fn(
        (_ref: string, ctx: { forceRefresh?: boolean }) =>
          Promise.resolve({
            entries: [
              {
                imdbId: ctx.forceRefresh ? fresh.id : MOVIE.id,
                meta: ctx.forceRefresh ? fresh : MOVIE,
              },
            ],
            complete: true,
          }),
      );
      useFakeProvider(fakeAdapter("letterboxd", { fetchSource }));
      const request = config({
        provider: "letterboxd",
        sourceRef: "users/leo/watchlist",
        policy,
      });
      const earlier = readList(request);
      await writing.promise;
      const manual = readList({ ...request, policy: "manual" });
      try {
        expect(fetchSource).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
      await earlier;
      expect((await manual).metas.map((item) => item.id)).toEqual([fresh.id]);
      expect(fetchSource).toHaveBeenLastCalledWith("users/leo/watchlist", {
        connection: null,
        forceRefresh: true,
      });
      const cached = await listCache.getCachedList(LIST_ID, {
        provider: "letterboxd",
        sourceRef: "users/leo/watchlist",
      });
      expect(cached?.data.metas.map((item) => item.id)).toEqual([fresh.id]);
    },
  );
  it("coalesces concurrent cache misses for the same Source list", async () => {
    imdb.lists.set(SOURCE_REF, [MOVIE]);
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    server.use(
      http.post(IMDB_GRAPHQL, async ({ request }) => {
        requested.resolve();
        await release.promise;
        return imdb.answer(request);
      }),
    );

    const first = readList(config());
    const second = readList(config());

    await requested.promise;
    expect(listCache.getCachedList).toHaveBeenCalledTimes(2);
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { metas: [MOVIE] },
      { metas: [MOVIE] },
    ]);
    expect(imdb.requestsOf("ListPage")).toHaveLength(1);
    expect(listCache.writeCachedList).toHaveBeenCalledOnce();
  });

  it("does not share a read between a Connection request and a public one", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({
        entries: [{ imdbId: MOVIE.id, meta: MOVIE }],
        complete: true,
      }),
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
      readList({ ...base, allowConnection: true }),
      readList({ ...base, allowConnection: false }),
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

    await expect(readList(config())).resolves.toEqual({
      metas: [MOVIE],
    });
    expect(imdb.requests).toEqual([]);
  });

  it("reads the Provider again once the cache is older than its freshness", async () => {
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));
    imdb.lists.set(SOURCE_REF, [meta("tt0000002")]);

    const result = await readList(config());

    expect(result.metas.map((item) => item.id)).toEqual(["tt0000002"]);
    expect(cache.get(LIST_ID)?.data.metas.map((item) => item.id)).toEqual([
      "tt0000002",
    ]);
  });

  it("reads in the background when a stale cache can be served meanwhile", async () => {
    const priorities: string[] = [];
    imdb.lists.set(SOURCE_REF, [meta("tt0000002")]);
    server.use(
      http.post(IMDB_GRAPHQL, ({ request }) => {
        priorities.push(currentReadPriority());
        return imdb.answer(request);
      }),
    );
    await readList(config());
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));
    await readList(config());

    expect(priorities).toEqual(["interactive", "background"]);
  });

  it("reads the new Source list of an edited List, even with a fresh cache", async () => {
    cache.seed(LIST_ID, [MOVIE], new Date(), {
      provider: "imdb",
      sourceRef: "ls111111111",
    });
    imdb.lists.set(SOURCE_REF, [meta("tt0000002")]);

    const result = await readList(config());

    expect(imdb.requestsOf("ListPage")).toHaveLength(1);
    expect(result.metas.map((item) => item.id)).toEqual(["tt0000002"]);
    await expect(readList(config())).resolves.toEqual(result);
    expect(imdb.requestsOf("ListPage")).toHaveLength(1);
  });

  it("does not fall back on the cache of the previous Source list", async () => {
    cache.seed(LIST_ID, [MOVIE], new Date(), {
      provider: "imdb",
      sourceRef: "ls111111111",
    });
    imdbDown();

    await expect(readList(config())).rejects.toBeInstanceOf(
      ListUnavailableError,
    );
  });

  it("does not share a read between two Source lists of the same List", async () => {
    imdb.lists.set("ls111111111", [meta("tt1")]);
    imdb.lists.set(SOURCE_REF, [meta("tt2")]);

    const [before, after] = await Promise.all([
      readList(config({ sourceRef: "ls111111111" })),
      readList(config()),
    ]);

    expect(before.metas.map((item) => item.id)).toEqual(["tt1"]);
    expect(after.metas.map((item) => item.id)).toEqual(["tt2"]);
  });

  it("updates last_fetched_at after a Provider read unless asked not to", async () => {
    const account = seedAccount({ last_fetched_at: new Date(0).toISOString() });
    imdb.lists.set(SOURCE_REF, [MOVIE]);

    await readList(config({ accountId: account.id }));

    expect(db.getTable("accounts")[0].last_fetched_at).not.toBe(
      new Date(0).toISOString(),
    );
  });
});

describe("Provider pipeline: resolve, enrich, cache", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes metadata after seven days despite daily catalog refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const origin = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(origin);
    const id = "tt8800001";
    useFakeProvider(fakeAdapter("trakt", { entries: [{ imdbId: id }] }));
    imdb.titles.set(id, meta(id, { imdbRating: "7.5" }));
    const source = config({
      provider: "trakt",
      sourceRef: "users/leo/watchlist",
      policy: "manual",
    });
    await readList(source);
    for (let day = 1; day < 7; day++) {
      vi.setSystemTime(origin.getTime() + day * 24 * 60 * 60_000);
      expect((await readList(source)).metas[0].imdbRating).toBe("7.5");
    }
    expect(titleBatches()).toHaveLength(1);
    vi.setSystemTime(origin.getTime() + 7 * 24 * 60 * 60_000);
    imdb.titles.set(id, meta(id, { imdbRating: "8.5" }));
    const refreshed = await readList(source);
    expect(refreshed.metas[0].imdbRating).toBe("8.5");
    expect(titleBatches()).toHaveLength(2);
    expect(refreshed.metas[0]).not.toHaveProperty("enrichedAt");
  });
  it("resolves and enriches the entries of an adapter that only returns IDs", async () => {
    const entries: SourceEntry[] = [
      { imdbId: "tt0000001", type: "movie" },
      { externalIds: { tmdb: { id: 550, type: "movie" } }, type: "movie" },
      { externalIds: { tmdb: { id: 999, type: "movie" } }, type: "movie" },
      { imdbId: "tt0000001", type: "movie" },
    ];
    const strategy = vi.fn((pending: SourceEntry[]) =>
      Promise.resolve(
        new Map(
          pending.flatMap((entry, index) =>
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
    serveTitles(["tt0000001", "tt0137523"]);

    const result = await readList(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    );

    expect(result.metas.map((item) => item.id)).toEqual([
      "tt0000001",
      "tt0137523",
    ]);
    expect(titleBatches()).toEqual([["tt0000001", "tt0137523"]]);
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
                  pending.map((entry, index) => [
                    index,
                    `tt${String(entry.externalIds?.tmdb?.id).padStart(7, "0")}`,
                  ]),
                ),
              ),
          },
        ],
      }),
    );
    serveTitles(
      entries.map(
        (entry) => `tt${String(entry.externalIds?.tmdb?.id).padStart(7, "0")}`,
      ),
    );

    await readList(
      config({ provider: "senscritique", sourceRef: "users/leo/wishes" }),
    );

    const storedAt = cache.get(LIST_ID)?.cachedAt.getTime() ?? 0;
    const staleIn = storedAt + 6 * 60 * 60_000 - Date.now();
    expect(staleIn).toBeGreaterThan(60_000);
    expect(staleIn).toBeLessThanOrEqual(2 * 60_000);
    expect(cache.get(LIST_ID)?.data.metas).toHaveLength(300);
  });

  it("reuses metadata from the previous cache generation", async () => {
    const cachedAt = new Date(Date.now() - 2 * 60 * 60_000);
    cache.seed(
      LIST_ID,
      [
        {
          ...meta("tt0000001", { name: "Cached" }),
          enrichedAt: cachedAt.toISOString(),
        },
      ],
      cachedAt,
    );
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [{ imdbId: "tt0000001" }, { imdbId: "tt0000002" }],
      }),
    );
    serveTitles(["tt0000001", "tt0000002"]);

    const result = await readList(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    );

    expect(result.metas.map((item) => item.name)).toEqual([
      "Cached",
      "Title tt0000002",
    ]);
    expect(titleBatches()).toEqual([["tt0000002"]]);
  });

  it("links each item back to its page on the Provider, once", async () => {
    const url = "https://trakt.tv/movies/the-shawshank-redemption-1994";
    const cachedAt = new Date(Date.now() - 2 * 60 * 60_000);
    cache.seed(
      LIST_ID,
      [
        {
          ...meta("tt0000001", {
            description: `A banker.\n\nMore on Trakt: ${url}`,
          }),
          enrichedAt: cachedAt.toISOString(),
        },
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
    serveTitles(["tt0000001", "tt0000002", "tt0000003"]);

    const result = await readList(
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

    const error = await readList(
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

    const error = await readList(
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

    const error = await readList(
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
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));

    const error = await readList(
      config({
        accountId: account.id,
        provider: "simkl",
        sourceRef: "me/plantowatch",
        allowConnection: true,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "needs_connection" });
  });

  it("does not serve the cache of a Letterboxd list that the Provider no longer shows", async () => {
    useFakeProvider(
      fakeAdapter("letterboxd", {
        fetchSource: () =>
          Promise.reject(
            new SourceUnavailableError("not_found", "revoked share link"),
          ),
      }),
    );
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));

    const error = await readList(
      config({ provider: "letterboxd", sourceRef: "share/v1:ciphertext" }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "not_found" });
  });

  it("a manual refresh on a revoked Letterboxd list drops the fresh cache so Titles cannot return", async () => {
    useFakeProvider(
      fakeAdapter("letterboxd", {
        fetchSource: () =>
          Promise.reject(
            new SourceUnavailableError("not_found", "revoked share link"),
          ),
      }),
    );
    cache.seed(LIST_ID, [MOVIE], new Date());

    await expect(
      readList(
        config({
          provider: "letterboxd",
          sourceRef: "share/v1:ciphertext",
          policy: "manual",
        }),
      ),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(cache.get(LIST_ID)).toBeNull();

    await expect(
      readList(
        config({ provider: "letterboxd", sourceRef: "share/v1:ciphertext" }),
      ),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("keeps serving the cache of a Letterboxd list on a transient failure", async () => {
    useFakeProvider(
      fakeAdapter("letterboxd", {
        fetchSource: () =>
          Promise.reject(
            new SourceUnavailableError("unavailable", "Letterboxd timed out"),
          ),
      }),
    );
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 2 * 60 * 60_000));

    await expect(
      readList(
        config({ provider: "letterboxd", sourceRef: "users/leo/lists/x" }),
      ),
    ).resolves.toEqual({ metas: [MOVIE] });
  });

  it("reports an honest failure when asked not to fall back on the cache", async () => {
    cache.seed(LIST_ID, [MOVIE], new Date(0));
    imdbDown();

    await expect(readList(config({ policy: "manual" }))).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(readList(config())).resolves.toEqual({
      metas: [MOVIE],
    });
  });
});

it("rejects a read that finishes after its Connection was disconnected", async () => {
  const account = seedAccount();
  seedConnection(account.id, "trakt");
  seedList(account.id, {
    id: LIST_ID,
    provider: "trakt",
    source_ref: "me/watchlist",
  });
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (snapshot: SourceSnapshot) => void;
  const snapshot = new Promise<SourceSnapshot>((resolve) => {
    finish = resolve;
  });
  useFakeProvider(
    fakeAdapter("trakt", {
      fetchSource: () => {
        started();
        return snapshot;
      },
    }),
  );
  const read = config({
    accountId: account.id,
    provider: "trakt",
    sourceRef: "me/watchlist",
    allowConnection: true,
  });
  const pending = readList(read);
  pending.catch(() => {});
  await began;
  await disconnectProvider(account.id, "trakt");
  finish({ entries: [{ imdbId: MOVIE.id, meta: MOVIE }], complete: true });
  await expect(pending).rejects.toMatchObject({
    reason: "needs_connection",
  });
  expect(cache.get(LIST_ID)).toBeNull();
  await expect(readList(read)).rejects.toMatchObject({
    reason: "needs_connection",
  });
});
