import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});

import app from "../index.js";
import { SourceUnavailableError } from "../providers/types";
import * as scraper from "../services/imdb-scraper";
import {
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

let accountId = "";

function seedUser(imdbUserId: string) {
  accountId = seedLegacyAccount(imdbUserId).id;
}

function seedWatchlist(id: string, sortOption = "added_at-asc") {
  seedList(accountId, { id, source_ref: OWNER, sort_option: sortOption });
}

function seedCache(listId: string, metas: StremioMeta[], cachedAt?: string) {
  if (metas.length === 0) return;
  cache.seed(listId, metas, cachedAt ? new Date(cachedAt) : new Date());
}

const CACHED_MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};

interface CatalogMeta {
  id: string;
  type: string;
  name: string;
}
interface CatalogResponse {
  metas: CatalogMeta[];
}

// Movie catalog for a list with no cache row → the fetch failure has nothing to
// fall back on, so getListCatalog throws and the route's catch runs.
function requestMovieCatalog() {
  return app.request(`/${OWNER}/catalog/movie/wl-${UUID_1}-movie.json`);
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
        seedUser(OWNER);
        seedWatchlist(UUID_1);
        vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(new Error(error));

        const res = await app.request(
          `/${OWNER}/catalog/movie/wl-${UUID_1}-movie${suffix}`,
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ metas: [] });
      });
    },
  );

  it("searches stale cached titles when the IMDb list becomes private", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(
      UUID_1,
      [CACHED_MOVIE, { ...CACHED_MOVIE, id: "tt0078748", name: "Alien" }],
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    );
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/search=alien.json`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas.map((meta) => meta.id)).toEqual(["tt0078748"]);
  });

  it("returns a 200 'private' card when the IMDb list is private and there is no cache", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestMovieCatalog();

    // Pre-fix this was a 500 that Stremio retry-stormed; now it's a friendly card.
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:private");
    expect(body.metas[0].type).toBe("movie");
    expect(body.metas[0].name.toLowerCase()).toContain("private");
  });

  it("names the IMDb watchlist a watchlist, and an IMDb list a list", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedList(accountId, { id: UUID_2, source_ref: "ls012345678", position: 1 });
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );
    vi.spyOn(scraper, "fetchList").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const watchlist = (await (
      await requestMovieCatalog()
    ).json()) as CatalogResponse;
    const list = (await (
      await app.request(`/${OWNER}/catalog/movie/wl-${UUID_2}-movie.json`)
    ).json()) as CatalogResponse;

    expect(watchlist.metas[0].name).toBe("⚠️ This IMDb watchlist is private");
    expect(list.metas[0].name).toBe("⚠️ This IMDb list is private");
  });

  it("returns a 200 'not found' card when the IMDb list does not exist", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_NOT_FOUND),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:not_found");
  });

  it("shows the private card even when an empty cache exists (does not serve the empty cache)", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    // Fresh but EMPTY cache — the real-world case (list cached empty, then went
    // private). Pre-fix this served the empty cache → silently-empty catalog.
    seedCache(UUID_1, []);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:private");
  });

  it("still serves a NON-empty stale cache as a graceful fallback when fetch fails", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    // Stale + non-empty: keep showing the user's last-known items rather than an
    // error — the fetch failure must not wipe a populated list.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    seedCache(UUID_1, [CACHED_MOVIE], twoDaysAgo.toISOString());
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe(CACHED_MOVIE.id);
  });

  it.each([".json", "/search=alien.json"])(
    "keeps the 500 for an unexpected/transient server error at %s",
    async (suffix) => {
      seedUser(OWNER);
      seedWatchlist(UUID_1);
      vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
        new Error("ECONNRESET while talking to IMDb"),
      );

      const res = await app.request(
        `/${OWNER}/catalog/movie/wl-${UUID_1}-movie${suffix}`,
      );

      expect(res.status).toBe(500);
      expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
    },
  );
});

describe("catalog pagination", () => {
  it("serves Stremio pages of at most 100 items using the skip extra", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(
      UUID_1,
      Array.from(
        { length: 205 },
        (_, index): StremioMeta => ({
          ...CACHED_MOVIE,
          id: `tt${String(index).padStart(7, "0")}`,
          name: `Movie ${index}`,
        }),
      ),
    );

    const first = await requestMovieCatalog();
    const second = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=100.json`,
    );
    const last = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=200.json`,
    );

    const firstBody = (await first.json()) as CatalogResponse;
    const secondBody = (await second.json()) as CatalogResponse;
    const lastBody = (await last.json()) as CatalogResponse;
    expect(firstBody.metas).toHaveLength(100);
    expect(secondBody.metas).toHaveLength(100);
    expect(lastBody.metas).toHaveLength(5);
    expect(firstBody.metas[0].id).toBe("tt0000000");
    expect(secondBody.metas[0].id).toBe("tt0000100");
    expect(lastBody.metas[0].id).toBe("tt0000200");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
  });

  it("keeps random pages stable and non-overlapping within a cache generation", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1, "random");
    seedCache(
      UUID_1,
      Array.from(
        { length: 205 },
        (_, index): StremioMeta => ({
          ...CACHED_MOVIE,
          id: `tt${String(index).padStart(7, "0")}`,
          name: `Movie ${index}`,
        }),
      ),
    );

    const first = await requestMovieCatalog();
    const second = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=100.json`,
    );
    const repeatedFirst = await requestMovieCatalog();

    const firstIds = ((await first.json()) as CatalogResponse).metas.map(
      (meta) => meta.id,
    );
    const secondIds = ((await second.json()) as CatalogResponse).metas.map(
      (meta) => meta.id,
    );
    const repeatedFirstIds = (
      (await repeatedFirst.json()) as CatalogResponse
    ).metas.map((meta) => meta.id);

    expect(repeatedFirstIds).toEqual(firstIds);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(200);
  });

  it("rejects an invalid skip value", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=wat.json`,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
  });
});

describe("catalog dropdown filters", () => {
  const titles: StremioMeta[] = [
    {
      ...CACHED_MOVIE,
      id: "tt0000001",
      name: "Zulu",
      genres: ["Drama"],
      releaseInfo: "1990",
      imdbRating: "7",
      runtime: "2h 5m",
    },
    {
      ...CACHED_MOVIE,
      id: "tt0000002",
      name: "Alpha",
      genres: ["Comedy"],
      releaseInfo: "2000",
      imdbRating: "9",
      runtime: "45m",
    },
    {
      ...CACHED_MOVIE,
      id: "tt0000003",
      name: "Beta",
      genres: ["Drama", "Comedy"],
      releaseInfo: "1999",
      imdbRating: "8",
      runtime: "1h 30m",
    },
    { ...CACHED_MOVIE, id: "tt0000004", name: "Unknown", genres: ["Drama"] },
    {
      ...CACHED_MOVIE,
      id: "tt0000005",
      type: "series",
      name: "Series",
      genres: ["Comedy"],
      releaseInfo: "1995",
      runtime: "20m",
    },
  ];

  beforeEach(() => {
    seedUser(OWNER);
    seedWatchlist(UUID_1, "title-desc");
    seedCache(UUID_1, titles);
  });

  async function names(extra: string) {
    const response = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/${extra}.json`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as CatalogResponse).metas.map(
      (meta) => meta.name,
    );
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
    expect(await names(`genre=${encodeURIComponent(filter)}`)).toEqual(
      expected,
    );
    expect(db.getTable("lists")[0].sort_option).toBe("title-desc");
  });

  it("handles both path parameter orders and query parameters", async () => {
    expect(await names("genre=Comedy&skip=1")).toEqual(["Alpha"]);
    expect(await names("skip=1&genre=Comedy")).toEqual(["Alpha"]);
    const response = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie.json?genre=Comedy&skip=1`,
    );
    expect(
      ((await response.json()) as CatalogResponse).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["Alpha"]);
  });

  it("filters the full catalog before taking a page", async () => {
    cache.reset();
    seedCache(
      UUID_1,
      Array.from({ length: 410 }, (_, i) => ({
        ...CACHED_MOVIE,
        id: `tt${String(i).padStart(7, "0")}`,
        name: `Movie ${i}`,
        genres: [i % 2 === 0 ? "Comedy" : "Drama"],
      })),
    );
    const first = await names("genre=Comedy");
    const second = await names("genre=Comedy&skip=100");
    const last = await names("genre=Comedy&skip=200");
    expect([first.length, second.length, last.length]).toEqual([100, 100, 5]);
    expect(new Set([...first, ...second, ...last]).size).toBe(205);
  });

  it("keeps the dropdown shuffle stable between pages", async () => {
    const first = await names("genre=Shuffle");
    expect(await names("genre=Shuffle")).toEqual(first);
    expect(await names("genre=Shuffle&skip=2")).toEqual(first.slice(2));
    expect(first).toHaveLength(4);
  });
  it("combines saved filters with the dropdown and search", async () => {
    db.getTable("lists")[0].catalog_settings = {
      genre: "Comedy",
      decade: 1990,
      maxRuntime: 90,
      minRating: 8,
    };
    expect(await names("genre=IMDb%20Rating%20(Highest)")).toEqual(["Beta"]);
    expect(await names("search=bet")).toEqual(["Beta"]);
    expect(await names("search=alpha")).toEqual([]);
    expect(await names("genre=Drama&search=BETA")).toEqual(["Beta"]);
  });

  it("searches literal encoded ampersands, plus signs and accented titles", async () => {
    cache.reset();
    seedCache(UUID_1, [{ ...CACHED_MOVIE, name: "Amélie & A+B" }]);
    expect(await names(`search=${encodeURIComponent("amelie & a+b")}`)).toEqual(
      ["Amélie & A+B"],
    );
    expect(await names("search=%20%20")).toEqual([]);
  });

  it("only serves enabled preset catalogs and shares their source list", async () => {
    const presetUrl = `/${OWNER}/catalog/movie/wl-${UUID_1}-movie--short.json`;
    expect(
      ((await (await app.request(presetUrl)).json()) as CatalogResponse).metas,
    ).toEqual([]);
    db.getTable("lists")[0].catalog_settings = {
      presets: ["short", "rated", "shuffle"],
      minRating: 8,
    };
    const response = await app.request(presetUrl);
    expect(
      ((await response.json()) as CatalogResponse).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["Beta", "Alpha"]);
    const rated = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie--rated.json`,
    );
    expect(
      ((await rated.json()) as CatalogResponse).metas.map((meta) => meta.name),
    ).toEqual(["Alpha", "Beta"]);
  });
});

describe("catalog access through Account IDs and Legacy aliases", () => {
  it("serves the same cached catalog through a private Account ID", async () => {
    const account = seedAccount();
    seedList(account.id, { id: UUID_1, source_ref: OWNER });
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await app.request(
      `/${account.id}/catalog/movie/wl-${UUID_1}-movie.json`,
    );

    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as CatalogResponse).metas.map((meta) => meta.id),
    ).toEqual([CACHED_MOVIE.id]);
  });

  it("keeps old `ur…` catalog URLs working through the Legacy alias", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await requestMovieCatalog();

    expect(
      ((await res.json()) as CatalogResponse).metas.map((meta) => meta.id),
    ).toEqual([CACHED_MOVIE.id]);
  });

  it("does not answer through the internal ID of an Account that has a Legacy alias", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await app.request(
      `/${accountId}/catalog/movie/wl-${UUID_1}-movie.json`,
    );

    expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
  });

  it("does not serve a List of another Account", async () => {
    seedUser(OWNER);
    const other = seedAccount();
    seedList(other.id, { id: UUID_1, source_ref: "ur12345678" });
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await requestMovieCatalog();

    expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
  });

  it("never serves a Connection list through a Legacy alias, even from cache", async () => {
    seedUser(OWNER);
    seedList(accountId, {
      id: UUID_1,
      provider: "trakt",
      source_ref: "me/watchlist",
    });
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
  });
});

describe("information cards for Lists that cannot be read", () => {
  async function requestPrivateCatalog(
    provider: "trakt" | "simkl",
    sourceRef: string,
  ) {
    const account = seedAccount();
    seedList(account.id, { id: UUID_1, provider, source_ref: sourceRef });
    const res = await app.request(
      `/${account.id}/catalog/movie/wl-${UUID_1}-movie.json`,
    );
    expect(res.status).toBe(200);
    return { account, body: (await res.json()) as CatalogResponse };
  }

  it("asks to connect the Provider when a Connection list has no Connection", async () => {
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    const { body } = await requestPrivateCatalog("trakt", "me/watchlist");

    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:needs_connection");
    expect(body.metas[0].name).toBe(
      "⚠️ This watchlist needs your Trakt account",
    );
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("reads a Connection list once the Account has a Connection", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({
        entries: [{ imdbId: CACHED_MOVIE.id, meta: CACHED_MOVIE }],
        complete: true,
      }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    seedList(account.id, {
      id: UUID_1,
      provider: "trakt",
      source_ref: "me/watchlist",
    });

    const res = await app.request(
      `/${account.id}/catalog/movie/wl-${UUID_1}-movie.json`,
    );

    expect(
      ((await res.json()) as CatalogResponse).metas.map((meta) => meta.id),
    ).toEqual([CACHED_MOVIE.id]);
    expect(fetchSource).toHaveBeenCalledWith(
      "me/watchlist",
      expect.objectContaining({
        connection: expect.objectContaining({ provider: "trakt" }) as unknown,
      }),
    );
  });

  it("says the Provider is temporarily unavailable when it is turned off", async () => {
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    process.env.DISABLED_PROVIDERS = "trakt";

    const { body } = await requestPrivateCatalog(
      "trakt",
      "users/leo/watchlist",
    );

    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:disabled");
    expect(body.metas[0].name).toBe("⚠️ Trakt is temporarily unavailable");
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("keeps serving the last cached Catalog of a turned-off Provider", async () => {
    useFakeProvider(fakeAdapter("trakt"));
    process.env.DISABLED_PROVIDERS = "trakt";
    const account = seedAccount();
    seedList(account.id, {
      id: UUID_1,
      provider: "trakt",
      source_ref: "users/leo/watchlist",
    });
    seedCache(UUID_1, [CACHED_MOVIE], new Date(0).toISOString());

    const res = await app.request(
      `/${account.id}/catalog/movie/wl-${UUID_1}-movie.json`,
    );

    expect(
      ((await res.json()) as CatalogResponse).metas.map((meta) => meta.id),
    ).toEqual([CACHED_MOVIE.id]);
  });

  it("explains that a list needs a paid plan", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () =>
          Promise.reject(
            new SourceUnavailableError("premium_only", "VIP only"),
          ),
      }),
    );

    const { body } = await requestPrivateCatalog("trakt", "lists/123");

    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:premium_only");
    expect(body.metas[0].name).toBe("⚠️ This list needs a paid Trakt plan");
  });

  it("uses Provider-neutral copy for private lists of other Providers", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () =>
          Promise.reject(new SourceUnavailableError("private", "private")),
      }),
    );

    const { body } = await requestPrivateCatalog(
      "trakt",
      "users/leo/lists/secret",
    );

    expect(body.metas[0].id).toBe("stremlist:unavailable:private");
    expect(body.metas[0].name).toBe("⚠️ This Trakt list is private");
  });
});

describe("expired Connections", () => {
  it("asks to connect again instead of failing with a 500", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: async (_ref, ctx) => {
          await ctx.connection?.getAccessToken();
          return { entries: [], complete: true };
        },
      }),
    );
    const account = seedAccount();
    // Expired, and no refresh token to get a new one.
    seedConnection(account.id, "trakt", {
      refreshToken: null,
      expiresAt: new Date(Date.now() - 60_000),
    });
    seedList(account.id, {
      id: UUID_1,
      provider: "trakt",
      source_ref: "me/watchlist",
    });

    const res = await app.request(
      `/${account.id}/catalog/movie/wl-${UUID_1}-movie.json`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas.map((meta) => meta.id)).toEqual([
      "stremlist:unavailable:needs_connection",
    ]);
  });
});
