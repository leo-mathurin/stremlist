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
  useTestEncryptionKey,
} from "../../test/helpers/account.fixture";
import { cache } from "../../test/helpers/list-cache.test-utils";
import { db, resetRpc } from "../../test/helpers/mock-supabase";
import { FakeImdb, IMDB_GRAPHQL } from "../../test/helpers/imdb.test-utils";
import {
  FakeLetterboxd,
  LETTERBOXD,
} from "../../test/helpers/letterboxd.test-utils";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { resetR2 } from "../../test/helpers/r2.test-utils";
import {
  FakeSensCritique,
  senscritiqueProduct,
} from "../../test/helpers/senscritique.test-utils";
import {
  FakeSimkl,
  simklPageOf,
  useSimklApp,
} from "../../test/helpers/simkl.test-utils";
import { FakeTrakt, useTraktApp } from "../../test/helpers/trakt.test-utils";
import { FakeWikidata } from "../../test/helpers/wikidata.test-utils";
import { encryptSecret } from "../../lib/crypto";
import { currentReadPriority } from "../../providers/read-priority";
import { clearTrendingReads } from "../../providers/simkl/trending";
import { TRAKT_API, TRAKT_AUTH } from "../../providers/trakt/api";
import * as listCache from "../list-cache";
import type { ListRead } from "../lists";
import {
  getListCatalog,
  ListUnavailableError,
  disconnectProvider,
} from "../lists";

const LIST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_LIST_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_REF = "ls123456789";
const TRENDING = "movies/week_100.json";
const WATCHLIST = "/users/leo/watchlist";

const imdb = new FakeImdb();
const trakt = new FakeTrakt();
const simkl = new FakeSimkl();
const senscritique = new FakeSensCritique();
const wikidata = new FakeWikidata();
const letterboxd = new FakeLetterboxd();
const server = useMswServer();

vi.spyOn(listCache, "getCachedList");
vi.spyOn(listCache, "writeCachedList");

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

function serveTrakt(path: string, metas: StremioMeta[]) {
  trakt.serve(path, metas);
  for (const item of metas) imdb.titles.set(item.id, item);
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

function revokedLetterboxdShare(path: string) {
  return `share/${encryptSecret(path)}`;
}

let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  vi.clearAllMocks();
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
  vi.stubEnv("TMDB_API_KEY", "");
  useTraktApp();
  useSimklApp();
  useTestEncryptionKey();
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  clearTrendingReads();
  imdb.reset();
  trakt.reset();
  simkl.reset();
  senscritique.reset();
  wikidata.reset();
  letterboxd.reset();
  server.use(
    imdb.handler,
    trakt.handler,
    ...simkl.handlers,
    senscritique.handler,
    wikidata.handler,
    ...letterboxd.handlers,
  );
});

afterEach(() => {
  clock = Date.now();
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
      serveTitles([MOVIE.id, fresh.id]);
      simkl.trending.set(TRENDING, [MOVIE]);
      const request = config({
        provider: "simkl",
        sourceRef: "trending/movies",
        policy,
      });
      const earlier = readList(request);
      await writing.promise;
      simkl.trending.set(TRENDING, [fresh]);
      const manual = readList({ ...request, policy: "manual" });
      try {
        expect(simkl.requestsOf(TRENDING)).toHaveLength(1);
      } finally {
        release();
      }
      await earlier;
      expect((await manual).metas.map((item) => item.id)).toEqual([fresh.id]);
      expect(simkl.requestsOf(TRENDING)).toHaveLength(2);
      const cached = await listCache.getCachedList(LIST_ID, {
        provider: "simkl",
        sourceRef: "trending/movies",
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
    serveTrakt(WATCHLIST, [MOVIE]);
    const account = seedAccount();
    seedConnection(account.id, "trakt", { accessToken: "leo-token" });
    const base = config({
      accountId: account.id,
      provider: "trakt",
      sourceRef: "users/leo/watchlist",
    });

    await Promise.all([
      readList({ ...base, allowConnection: true }),
      readList({ ...base, allowConnection: false }),
    ]);

    const tokens = trakt.requestsOf(WATCHLIST).map((read) => read.token);
    expect(tokens).toHaveLength(2);
    expect(tokens).toEqual(expect.arrayContaining([null, "leo-token"]));
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
  it("refreshes metadata after seven days despite daily catalog refreshes", async () => {
    const origin = Date.now();
    const id = "tt8800001";
    serveTrakt(WATCHLIST, [meta(id)]);
    imdb.titles.set(id, meta(id, { imdbRating: "7.5" }));
    const source = config({
      provider: "trakt",
      sourceRef: "users/leo/watchlist",
      policy: "manual",
    });
    await readList(source);
    for (let day = 1; day < 7; day++) {
      vi.setSystemTime(origin + day * 24 * 60 * 60_000);
      expect((await readList(source)).metas[0].imdbRating).toBe("7.5");
    }
    expect(titleBatches()).toHaveLength(1);
    vi.setSystemTime(origin + 7 * 24 * 60 * 60_000);
    imdb.titles.set(id, meta(id, { imdbRating: "8.5" }));
    const refreshed = await readList(source);
    expect(refreshed.metas[0].imdbRating).toBe("8.5");
    expect(titleBatches()).toHaveLength(2);
    expect(refreshed.metas[0]).not.toHaveProperty("enrichedAt");
  });

  it("resolves and enriches the entries of an adapter that only returns IDs", async () => {
    vi.stubEnv("TMDB_API_KEY", "tmdb-key");
    const lookups: string[] = [];
    server.use(
      http.get(
        "https://api.themoviedb.org/3/movie/:id/external_ids",
        ({ params }) => {
          const tmdbId = String(params.id);
          lookups.push(tmdbId);
          return HttpResponse.json({
            imdb_id: tmdbId === "550" ? "tt0137523" : null,
          });
        },
      ),
    );
    trakt.serveItems(WATCHLIST, [
      { type: "movie", movie: { ids: { imdb: "tt0000001" } } },
      { type: "movie", movie: { ids: { trakt: 550, tmdb: 550 } } },
      { type: "movie", movie: { ids: { trakt: 999, tmdb: 999 } } },
      { type: "movie", movie: { ids: { imdb: "tt0000001" } } },
    ]);
    serveTitles(["tt0000001", "tt0137523"]);

    const result = await readList(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    );

    expect(result.metas.map((item) => item.id)).toEqual([
      "tt0000001",
      "tt0137523",
    ]);
    expect(lookups.sort()).toEqual(["550", "999"]);
    expect(titleBatches()).toEqual([["tt0000001", "tt0137523"]]);
    expect(db.getTable("title_id_map")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "trakt-movie",
          external_id: "550",
          imdb_id: "tt0137523",
        }),
        expect.objectContaining({
          namespace: "trakt-movie",
          external_id: "999",
          imdb_id: null,
        }),
      ]),
    );
    expect(cache.get(LIST_ID)?.data.metas).toHaveLength(2);
  });

  it("asks for a new read soon when the resolver left entries untried", async () => {
    const products = Array.from({ length: 350 }, (_, index) =>
      senscritiqueProduct(5000 + index),
    );
    const imdbIds = products.map(
      (product) => `tt${String(product.id).padStart(7, "0")}`,
    );
    senscritique.collections.set("leo:WISH:movie", products);
    products.forEach((product, index) => {
      wikidata.link("P10100", String(product.id), imdbIds[index]);
    });
    serveTitles(imdbIds);

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
    const cachedAt = new Date(Date.now() - 7 * 60 * 60_000);
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
    trakt.serve(WATCHLIST, [meta("tt0000001"), meta("tt0000002")]);
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
    const [first, second] = [meta("tt0000001"), meta("tt0000002")];
    const url = simklPageOf(first);
    const cachedAt = new Date(Date.now() - 7 * 60 * 60_000);
    cache.seed(
      LIST_ID,
      [
        {
          ...meta("tt0000001", {
            description: `A banker.\n\nMore on Simkl: ${url}`,
          }),
          enrichedAt: cachedAt.toISOString(),
        },
      ],
      cachedAt,
    );
    simkl.trending.set(TRENDING, [first, second]);
    trakt.serve(WATCHLIST, [meta("tt0000003")]);
    serveTitles(["tt0000001", "tt0000002", "tt0000003"]);

    const linked = await readList(
      config({ provider: "simkl", sourceRef: "trending/movies" }),
    );
    const unlinked = await readList(
      config({
        listId: OTHER_LIST_ID,
        provider: "trakt",
        sourceRef: "users/leo/watchlist",
      }),
    );

    expect(
      [...linked.metas, ...unlinked.metas].map((item) => item.description),
    ).toEqual([
      `A banker.\n\nMore on Simkl: ${url}`,
      `More on Simkl: ${simklPageOf(second)}`,
      "",
    ]);
  });

  it("answers `disabled` when the Provider is turned off and nothing is cached", async () => {
    serveTrakt(WATCHLIST, [MOVIE]);
    vi.stubEnv("DISABLED_PROVIDERS", "trakt");

    const error = await readList(
      config({ provider: "trakt", sourceRef: "users/leo/watchlist" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ListUnavailableError);
    expect(error).toMatchObject({ reason: "disabled", provider: "trakt" });
    expect(trakt.requests).toEqual([]);
  });

  it("answers `needs_connection` for a Connection list read through a Legacy alias", async () => {
    serveTrakt("/users/me/watchlist", [MOVIE]);
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
    expect(trakt.requests).toEqual([]);
  });

  it("answers `needs_connection` when a private Account has no Connection", async () => {
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
    const share = revokedLetterboxdShare("alice/list/secret");
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 7 * 60 * 60_000));

    const error = await readList(
      config({ provider: "letterboxd", sourceRef: share, policy: "prewarm" }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "not_found" });
    expect(letterboxd.urls).toEqual([`${LETTERBOXD}/alice/list/secret/`]);
    expect(cache.get(LIST_ID)).toBeNull();
  });

  it("a manual refresh on a revoked Letterboxd list drops the fresh cache so Titles cannot return", async () => {
    const share = revokedLetterboxdShare("alice/list/secret");
    cache.seed(LIST_ID, [MOVIE], new Date());

    await expect(
      readList(
        config({
          provider: "letterboxd",
          sourceRef: share,
          policy: "manual",
        }),
      ),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(cache.get(LIST_ID)).toBeNull();

    await expect(
      readList(config({ provider: "letterboxd", sourceRef: share })),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("keeps serving the cache of a Letterboxd list on a transient failure", async () => {
    letterboxd.serveAll(
      () => new HttpResponse("Letterboxd is down", { status: 503 }),
    );
    cache.seed(LIST_ID, [MOVIE], new Date(Date.now() - 7 * 60 * 60_000));

    await expect(
      readList(
        config({
          provider: "letterboxd",
          sourceRef: "users/leo/lists/x",
          policy: "prewarm",
        }),
      ),
    ).resolves.toEqual({ metas: [MOVIE] });
    expect(letterboxd.urls).not.toEqual([]);
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
  serveTrakt("/users/me/watchlist", [MOVIE]);
  const began = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  server.use(
    http.get(`${TRAKT_API}/users/me/watchlist`, async ({ request }) => {
      began.resolve();
      await finish.promise;
      return trakt.answer(request);
    }),
    http.post(
      `${TRAKT_AUTH}/oauth/revoke`,
      () => new HttpResponse(null, { status: 200 }),
    ),
  );
  const read = config({
    accountId: account.id,
    provider: "trakt",
    sourceRef: "me/watchlist",
    allowConnection: true,
  });
  const pending = readList(read);
  pending.catch(() => {});
  await began.promise;
  await disconnectProvider(account.id, "trakt");
  finish.resolve();
  await expect(pending).rejects.toMatchObject({
    reason: "needs_connection",
  });
  expect(cache.get(LIST_ID)).toBeNull();
  await expect(readList(read)).rejects.toMatchObject({
    reason: "needs_connection",
  });
});
