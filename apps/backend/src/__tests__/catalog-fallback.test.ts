import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/supabase", () => import("./helpers/mock-supabase.js"));
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));
vi.mock("../providers/registry", () => import("./helpers/mock-registry.js"));

import app from "../index.js";
import { SourceUnavailableError } from "../providers/types";
import * as scraper from "../services/imdb-scraper";
import {
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

// Old installs reach their Account through the Legacy alias (`ur…`).
const OWNER = "ur216216210";
const UUID_1 = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const UUID_2 = "0f4ef1b5-0a8c-4a4e-9f1e-3b2c1d0e9a87";
const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const CACHED_MOVIE = movie("tt0111161", { name: "The Shawshank Redemption" });

let accountId = "";

function seedWatchlist(sortOption = "added_at-asc") {
  accountId = seedLegacyAccount(OWNER).id;
  seedList(accountId, {
    id: UUID_1,
    source_ref: OWNER,
    sort_option: sortOption,
  });
}

function failWatchlist(message: string) {
  vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(new Error(message));
}

function numberedMovies(
  count: number,
  genres: (i: number) => string[] = () => [],
) {
  return Array.from({ length: count }, (_, i) =>
    movie(`tt${String(i).padStart(7, "0")}`, {
      name: `Movie ${i}`,
      genres: genres(i),
    }),
  );
}

async function catalog(suffix = ".json", { key = OWNER, list = UUID_1 } = {}) {
  const res = await app.request(
    `/${key}/catalog/movie/wl-${list}-movie${suffix}`,
  );
  return { res, body: (await res.json()) as { metas: StremioMeta[] } };
}

function ids(body: { metas: StremioMeta[] }) {
  return body.metas.map((meta) => meta.id);
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.restoreAllMocks();
});

describe("catalog route degrades gracefully on fetch failure", () => {
  describe.each([scraper.ERROR_PRIVATE, scraper.ERROR_NOT_FOUND])(
    "search when IMDb returns %s",
    (error) => {
      it.each([
        "/search=alien.json",
        ".json?search=alien",
        "/search=.json",
        ".json?search=",
      ])("returns no informational cards for %s", async (suffix) => {
        seedWatchlist();
        failWatchlist(error);

        const { res, body } = await catalog(suffix);

        expect(res.status).toBe(200);
        expect(body).toEqual({ metas: [] });
      });
    },
  );

  it("searches stale cached titles when the IMDb list becomes private", async () => {
    seedWatchlist();
    cache.seed(
      UUID_1,
      [CACHED_MOVIE, { ...CACHED_MOVIE, id: "tt0078748", name: "Alien" }],
      twoDaysAgo(),
    );
    failWatchlist(scraper.ERROR_PRIVATE);

    const { res, body } = await catalog("/search=alien.json");

    expect(res.status).toBe(200);
    expect(ids(body)).toEqual(["tt0078748"]);
  });

  it("returns a 200 'private' card naming a watchlist or a list when there is no cache", async () => {
    seedWatchlist();
    seedList(accountId, { id: UUID_2, source_ref: "ls012345678", position: 1 });
    failWatchlist(scraper.ERROR_PRIVATE);
    vi.spyOn(scraper, "fetchList").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const watchlist = await catalog();
    const list = await catalog(".json", { list: UUID_2 });

    // Pre-fix this was a 500 that Stremio retry-stormed; now it's a friendly card.
    expect(watchlist.res.status).toBe(200);
    expect(watchlist.body.metas).toMatchObject([
      {
        id: "stremlist:unavailable:private",
        type: "movie",
        name: "⚠️ This IMDb watchlist is private",
      },
    ]);
    expect(list.body.metas[0].name).toBe("⚠️ This IMDb list is private");
  });

  it("returns a 200 'not found' card when the IMDb list does not exist", async () => {
    seedWatchlist();
    failWatchlist(scraper.ERROR_NOT_FOUND);

    const { res, body } = await catalog();

    expect(res.status).toBe(200);
    expect(ids(body)).toEqual(["stremlist:unavailable:not_found"]);
  });

  it("still serves a NON-empty stale cache as a graceful fallback when fetch fails", async () => {
    seedWatchlist();
    cache.seed(UUID_1, [CACHED_MOVIE], twoDaysAgo());
    failWatchlist(scraper.ERROR_PRIVATE);

    const { res, body } = await catalog();

    expect(res.status).toBe(200);
    expect(ids(body)).toEqual([CACHED_MOVIE.id]);
  });

  it.each([".json", "/search=alien.json"])(
    "keeps the 500 for an unexpected/transient server error at %s",
    async (suffix) => {
      seedWatchlist();
      failWatchlist("ECONNRESET while talking to IMDb");

      const { res, body } = await catalog(suffix);

      expect(res.status).toBe(500);
      expect(body).toEqual({ metas: [] });
    },
  );
});

describe("catalog pagination", () => {
  it("serves Stremio pages of at most 100 items using the skip extra", async () => {
    seedWatchlist();
    cache.seed(UUID_1, numberedMovies(205));

    const first = await catalog();
    const pages = [
      first.body,
      (await catalog("/skip=100.json")).body,
      (await catalog("/skip=200.json")).body,
    ];

    expect(pages.map((page) => page.metas.length)).toEqual([100, 100, 5]);
    expect(pages.map((page) => page.metas[0].id)).toEqual([
      "tt0000000",
      "tt0000100",
      "tt0000200",
    ]);
    expect(first.res.headers.get("Cache-Control")).toBe("no-store");
    expect(first.res.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
  });

  it("keeps random pages stable and non-overlapping within a cache generation", async () => {
    seedWatchlist("random");
    cache.seed(UUID_1, numberedMovies(205));

    const firstIds = ids((await catalog()).body);
    const secondIds = ids((await catalog("/skip=100.json")).body);

    expect(ids((await catalog()).body)).toEqual(firstIds);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(200);
  });

  it("rejects an invalid skip value", async () => {
    seedWatchlist();
    cache.seed(UUID_1, [CACHED_MOVIE]);

    const { res, body } = await catalog("/skip=wat.json");

    expect(res.status).toBe(400);
    expect(body).toEqual({ metas: [] });
  });
});

describe("catalog dropdown filters", () => {
  const titles: StremioMeta[] = [
    movie("tt0000001", {
      name: "Zulu",
      genres: ["Drama"],
      releaseInfo: "1990",
      imdbRating: "7",
      runtime: "2h 5m",
    }),
    movie("tt0000002", {
      name: "Alpha",
      genres: ["Comedy"],
      releaseInfo: "2000",
      imdbRating: "9",
      runtime: "45m",
    }),
    movie("tt0000003", {
      name: "Beta",
      genres: ["Drama", "Comedy"],
      releaseInfo: "1999",
      imdbRating: "8",
      runtime: "1h 30m",
    }),
    movie("tt0000004", { name: "Unknown", genres: ["Drama"] }),
    movie("tt0000005", {
      type: "series",
      name: "Series",
      genres: ["Comedy"],
      releaseInfo: "1995",
      runtime: "20m",
    }),
  ];

  beforeEach(() => {
    seedWatchlist("title-desc");
    cache.seed(UUID_1, titles);
  });

  async function names(suffix: string) {
    const { res, body } = await catalog(suffix);
    expect(res.status).toBe(200);
    return body.metas.map((meta) => meta.name);
  }

  it.each([
    ["Comedy", ["Beta", "Alpha"]],
    ["1990s", ["Zulu", "Beta"]],
    ["Date Added (Newest)", ["Unknown", "Beta", "Alpha", "Zulu"]],
    ["Date Added (Oldest)", ["Zulu", "Alpha", "Beta", "Unknown"]],
    ["Title (A-Z)", ["Alpha", "Beta", "Unknown", "Zulu"]],
    ["IMDb Rating (Highest)", ["Alpha", "Beta", "Zulu", "Unknown"]],
    ["Release Year (Newest)", ["Alpha", "Beta", "Zulu", "Unknown"]],
    ["Shortest", ["Alpha", "Beta", "Zulu", "Unknown"]],
    ["Longest", ["Zulu", "Beta", "Alpha", "Unknown"]],
    ["Nonexistent", []],
  ])("applies %s without changing the saved sort", async (filter, expected) => {
    expect(await names(`/genre=${encodeURIComponent(filter)}.json`)).toEqual(
      expected,
    );
    expect(db.getTable("lists")[0].sort_option).toBe("title-desc");
  });

  it("handles both path parameter orders and query parameters", async () => {
    for (const suffix of [
      "/genre=Comedy&skip=1.json",
      "/skip=1&genre=Comedy.json",
      ".json?genre=Comedy&skip=1",
    ])
      expect(await names(suffix)).toEqual(["Alpha"]);
  });

  it("filters the full catalog before taking a page", async () => {
    cache.reset();
    cache.seed(
      UUID_1,
      numberedMovies(410, (i) => [i % 2 === 0 ? "Comedy" : "Drama"]),
    );
    const pages = [
      await names("/genre=Comedy.json"),
      await names("/genre=Comedy&skip=100.json"),
      await names("/genre=Comedy&skip=200.json"),
    ];
    expect(pages.map((page) => page.length)).toEqual([100, 100, 5]);
    expect(new Set(pages.flat()).size).toBe(205);
  });

  it("keeps the dropdown shuffle stable between pages", async () => {
    const first = await names("/genre=Shuffle.json");
    expect(await names("/genre=Shuffle.json")).toEqual(first);
    expect(await names("/genre=Shuffle&skip=2.json")).toEqual(first.slice(2));
    expect(first).toHaveLength(4);
  });

  it("combines saved filters with the dropdown and search", async () => {
    db.getTable("lists")[0].catalog_settings = {
      genre: "Comedy",
      decade: 1990,
      maxRuntime: 90,
      minRating: 8,
    };
    expect(await names("/genre=IMDb%20Rating%20(Highest).json")).toEqual([
      "Beta",
    ]);
    expect(await names("/search=bet.json")).toEqual(["Beta"]);
    expect(await names("/search=alpha.json")).toEqual([]);
    expect(await names("/genre=Drama&search=BETA.json")).toEqual(["Beta"]);
  });

  it("searches literal encoded ampersands, plus signs and accented titles", async () => {
    cache.reset();
    cache.seed(UUID_1, [{ ...CACHED_MOVIE, name: "Amélie & A+B" }]);
    expect(
      await names(`/search=${encodeURIComponent("amelie & a+b")}.json`),
    ).toEqual(["Amélie & A+B"]);
    expect(await names("/search=%20%20.json")).toEqual([]);
  });

  it("only serves enabled preset catalogs and shares their source list", async () => {
    expect((await catalog("--short.json")).body.metas).toEqual([]);
    db.getTable("lists")[0].catalog_settings = {
      presets: ["short", "rated", "shuffle"],
      minRating: 8,
    };
    expect(await names("--short.json")).toEqual(["Beta", "Alpha"]);
    expect(await names("--rated.json")).toEqual(["Alpha", "Beta"]);
  });
});

describe("catalog access through Account IDs and Legacy aliases", () => {
  it("serves the same cached catalog through a private Account ID", async () => {
    const account = seedAccount();
    seedList(account.id, { id: UUID_1, source_ref: OWNER });
    cache.seed(UUID_1, [CACHED_MOVIE]);

    const { res, body } = await catalog(".json", { key: account.id });

    expect(res.status).toBe(200);
    expect(ids(body)).toEqual([CACHED_MOVIE.id]);
  });

  it("keeps old `ur…` catalog URLs working through the Legacy alias", async () => {
    seedWatchlist();
    cache.seed(UUID_1, [CACHED_MOVIE]);

    expect(ids((await catalog()).body)).toEqual([CACHED_MOVIE.id]);
  });

  it("does not answer through the internal ID of an Account that has a Legacy alias", async () => {
    seedWatchlist();
    cache.seed(UUID_1, [CACHED_MOVIE]);

    expect((await catalog(".json", { key: accountId })).body).toEqual({
      metas: [],
    });
  });

  it("does not serve a List of another Account", async () => {
    seedLegacyAccount(OWNER);
    seedList(seedAccount().id, { id: UUID_1, source_ref: "ur12345678" });
    cache.seed(UUID_1, [CACHED_MOVIE]);

    expect((await catalog()).body).toEqual({ metas: [] });
  });

  it("never serves a Connection list through a Legacy alias, even from cache", async () => {
    accountId = seedLegacyAccount(OWNER).id;
    seedList(accountId, {
      id: UUID_1,
      provider: "trakt",
      source_ref: "me/watchlist",
    });
    cache.seed(UUID_1, [CACHED_MOVIE]);

    const { res, body } = await catalog();

    expect(res.status).toBe(200);
    expect(body).toEqual({ metas: [] });
  });
});

describe("information cards for Lists that cannot be read", () => {
  /** A Trakt List of a private Account, read through its catalog. */
  async function traktCatalog(
    sourceRef: string,
    connection?: Parameters<typeof seedConnection>[2],
  ) {
    const account = seedAccount();
    if (connection) seedConnection(account.id, "trakt", connection);
    seedList(account.id, {
      id: UUID_1,
      provider: "trakt",
      source_ref: sourceRef,
    });
    const { res, body } = await catalog(".json", { key: account.id });
    expect(res.status).toBe(200);
    return body;
  }

  it.each([
    {
      name: "asks to connect the Provider when a Connection list has no Connection",
      sourceRef: "me/watchlist",
      disabled: false,
      card: ["needs_connection", "⚠️ This watchlist needs your Trakt account"],
    },
    {
      name: "says the Provider is temporarily unavailable when it is turned off",
      sourceRef: "users/leo/watchlist",
      disabled: true,
      card: ["disabled", "⚠️ Trakt is temporarily unavailable"],
    },
  ])("$name", async ({ sourceRef, disabled, card: [reason, name] }) => {
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    if (disabled) process.env.DISABLED_PROVIDERS = "trakt";

    const body = await traktCatalog(sourceRef);

    expect(body.metas).toMatchObject([
      { id: `stremlist:unavailable:${reason}`, name },
    ]);
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "explains that a list needs a paid plan",
      sourceRef: "lists/123",
      error: new SourceUnavailableError("premium_only", "VIP only"),
      card: ["premium_only", "⚠️ This list needs a paid Trakt plan"],
    },
    {
      name: "uses Provider-neutral copy for private lists of other Providers",
      sourceRef: "users/leo/lists/secret",
      error: new SourceUnavailableError("private", "private"),
      card: ["private", "⚠️ This Trakt list is private"],
    },
  ])("$name", async ({ sourceRef, error, card: [reason, name] }) => {
    useFakeProvider(
      fakeAdapter("trakt", { fetchSource: () => Promise.reject(error) }),
    );

    const body = await traktCatalog(sourceRef);

    expect(body.metas).toMatchObject([
      { id: `stremlist:unavailable:${reason}`, name },
    ]);
  });

  it("reads a Connection list once the Account has a Connection", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({
        entries: [{ imdbId: CACHED_MOVIE.id, meta: CACHED_MOVIE }],
        complete: true,
      }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    expect(ids(await traktCatalog("me/watchlist", {}))).toEqual([
      CACHED_MOVIE.id,
    ]);
    expect(fetchSource).toHaveBeenCalledWith(
      "me/watchlist",
      expect.objectContaining({
        connection: expect.objectContaining({ provider: "trakt" }) as unknown,
      }),
    );
  });

  it("keeps serving the last cached Catalog of a turned-off Provider", async () => {
    useFakeProvider(fakeAdapter("trakt"));
    process.env.DISABLED_PROVIDERS = "trakt";
    cache.seed(UUID_1, [CACHED_MOVIE], new Date(0));

    expect(ids(await traktCatalog("users/leo/watchlist"))).toEqual([
      CACHED_MOVIE.id,
    ]);
  });

  it("asks to connect again when a Connection expired, instead of failing with a 500", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: async (_ref, ctx) => {
          await ctx.connection?.getAccessToken();
          return { entries: [], complete: true };
        },
      }),
    );

    // Expired, and no refresh token to get a new one.
    const body = await traktCatalog("me/watchlist", {
      refreshToken: null,
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect(ids(body)).toEqual(["stremlist:unavailable:needs_connection"]);
  });
});
