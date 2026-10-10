import { ADDON_VERSION } from "@stremlist/shared/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Http from "../http";
import type { ConnectionAccess } from "../types";
import { SourceUnavailableError } from "../types";

// R2 as an in-memory bucket.
const r2 = vi.hoisted(() => ({ objects: new Map<string, string>() }));
vi.mock("../../lib/r2", () => ({
  getR2Bucket: () => "test-bucket",
  getR2Client: () => ({
    send: (command: {
      constructor: { name: string };
      input: { Key: string; Body?: Uint8Array };
    }) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        r2.objects.set(Key, Buffer.from(Body ?? []).toString());
        return Promise.resolve({});
      }
      const value = r2.objects.get(Key);
      if (value === undefined) {
        return Promise.reject(
          Object.assign(new Error("missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(value) },
      });
    },
  }),
}));

// No real waiting in tests; remember the limits each limiter was built with.
const limiters = vi.hoisted(() => [] as [number, number][]);
vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof Http>();
  class RateLimiter {
    constructor(limit: number, windowMs: number) {
      limiters.push([limit, windowMs]);
    }
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, RateLimiter };
});

const { simklProvider, resetSimklState, simklItemUrl } =
  await import("../simkl");

// ---------------------------------------------------------------------------
// Fixtures (shapes from api.simkl.org, 2026-10)
// ---------------------------------------------------------------------------

const LIBRARY_KEY = "connections/acc-1/simkl/library.json";

function activities(overrides: {
  all: string;
  shows?: Record<string, string>;
  movies?: Record<string, string>;
  lists?: string;
}) {
  const base = "2026-09-01T00:00:00Z";
  return {
    all: overrides.all,
    settings: { all: base },
    tv_shows: {
      all: base,
      watching: base,
      plantowatch: base,
      hold: base,
      completed: base,
      dropped: base,
      rated_at: base,
      playback: base,
      removed_from_list: base,
      ...overrides.shows,
    },
    anime: {
      all: base,
      watching: base,
      plantowatch: base,
      hold: base,
      completed: base,
      dropped: base,
      rated_at: base,
      playback: base,
      removed_from_list: base,
    },
    movies: {
      all: base,
      plantowatch: base,
      completed: base,
      dropped: base,
      rated_at: base,
      playback: base,
      removed_from_list: base,
      ...overrides.movies,
    },
    custom_lists: {
      lists: {
        all: overrides.lists ?? "2026-09-21T20:53:09Z",
        regular: base,
        favorites: base,
        recommendations: base,
        auto: base,
      },
    },
  };
}

const SHOWS = {
  shows: [
    {
      added_to_watchlist_at: "2018-02-24T23:55:13Z",
      last_watched_at: null,
      user_rated_at: null,
      user_rating: null,
      status: "plantowatch",
      last_watched: null,
      next_to_watch: "S01E01",
      watched_episodes_count: 0,
      total_episodes_count: 178,
      not_aired_episodes_count: 0,
      show: {
        title: "Charmed",
        poster: "24/24273cee77f9d9f",
        year: 1998,
        ids: {
          simkl: 297,
          slug: "charmed",
          imdb: "tt0158552",
          tvdb: "70626",
          tmdb: "1981",
        },
      },
    },
    {
      added_to_watchlist_at: "2026-05-15T00:13:18Z",
      last_watched_at: "2026-05-15T00:13:18Z",
      user_rated_at: "2026-05-16T14:20:16Z",
      user_rating: 9,
      status: "completed",
      watched_episodes_count: 73,
      show: {
        title: "Game of Thrones",
        year: 2011,
        ids: {
          simkl: 17465,
          slug: "game-of-thrones",
          imdb: "tt0944947",
          tmdb: "1399",
        },
      },
      seasons: [
        {
          number: 1,
          episodes: [
            { number: 1, watched_at: "2026-05-15T00:13:18Z" },
            { number: 2, watched_at: "2026-05-15T00:13:18Z" },
          ],
        },
      ],
    },
    {
      added_to_watchlist_at: "2026-05-15T00:35:15Z",
      last_watched_at: "2026-05-15T00:35:15Z",
      user_rating: null,
      status: "watching",
      watched_episodes_count: 1,
      show: {
        title: "The Walking Dead",
        year: 2010,
        ids: { simkl: 2090, slug: "the-walking-dead", imdb: "tt1520211" },
      },
      seasons: [{ number: 1, episodes: [{ number: 2 }] }],
    },
  ],
};

const MOVIES = {
  movies: [
    {
      added_to_watchlist_at: "2026-05-14T06:49:56Z",
      last_watched_at: null,
      user_rating: null,
      status: "plantowatch",
      watched_episodes_count: 0,
      movie: {
        title: "Pulp Fiction",
        year: 1994,
        ids: { simkl: 54130, slug: "pulp-fiction", imdb: "tt0110912" },
      },
    },
    {
      added_to_watchlist_at: "2026-04-10T20:13:02Z",
      last_watched_at: "1994-09-01T16:00:00Z",
      user_rating: 10,
      status: "completed",
      watched_episodes_count: 0,
      movie: {
        title: "The Godfather",
        year: 1972,
        ids: {
          simkl: 53434,
          slug: "the-godfather",
          imdb: "tt0068646",
          tmdb: "238",
        },
      },
    },
    {
      // Legacy entry without an add time.
      added_to_watchlist_at: null,
      last_watched_at: null,
      user_rating: null,
      status: "plantowatch",
      movie: {
        title: "Old Movie",
        year: 1950,
        ids: { simkl: 999, slug: "old-movie", imdb: "tt0000999" },
      },
    },
  ],
};

const ANIME = {
  anime: [
    {
      added_to_watchlist_at: "2026-05-15T00:13:09Z",
      last_watched_at: "2026-05-15T00:13:09Z",
      user_rating: null,
      status: "completed",
      watched_episodes_count: 26,
      anime_type: "tv",
      show: {
        title: "Cowboy Bebop",
        year: 1998,
        ids: { simkl: 37089, slug: "cowboy-bebop", mal: "1", anidb: "23" },
      },
      seasons: [
        {
          number: 1,
          episodes: [{ number: 1, tvdb: { season: 1, episode: 1 } }],
        },
      ],
    },
    {
      added_to_watchlist_at: "2020-01-01T00:00:00Z",
      last_watched_at: "2026-05-01T00:00:00Z",
      user_rating: null,
      status: "watching",
      watched_episodes_count: 1,
      anime_type: "tv",
      mapped_tvdb_seasons: [2],
      show: {
        title: "Shingeki no Kyojin Season 2",
        year: 2017,
        ids: { simkl: 439744, imdb: "tt2560140", tmdb: "1429" },
      },
      seasons: [
        {
          number: 1,
          episodes: [{ number: 1, tvdb: { season: 2, episode: 1 } }],
        },
      ],
    },
    {
      added_to_watchlist_at: "2025-01-01T00:00:00Z",
      last_watched_at: null,
      user_rating: null,
      status: "plantowatch",
      anime_type: "movie",
      show: {
        title: "Attack on Titan: The Last Attack",
        year: 2024,
        ids: { simkl: 2544548, tmdb: "1333100" },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

type Route = (call: Call) => unknown;

let calls: Call[] = [];
let routes: Record<string, Route> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiCalls(): string[] {
  return calls.map(
    (call) =>
      `${call.method} ${call.url.pathname}${
        call.url.searchParams.get("date_from")
          ? `?date_from=${call.url.searchParams.get("date_from")}`
          : ""
      }`,
  );
}

function defaultRoutes(current: unknown): Record<string, Route> {
  return {
    "GET /sync/activities": () => current,
    "GET /sync/all-items/shows": () => SHOWS,
    "GET /sync/all-items/movies": () => MOVIES,
    "GET /sync/all-items/anime": () => ANIME,
  };
}

const connection: ConnectionAccess = {
  accountId: "acc-1",
  provider: "simkl",
  username: "leo",
  getAccessToken: () => Promise.resolve("simkl_at_test"),
  reportRefused: () => Promise.resolve(),
  reportWorking: () => Promise.resolve(),
};

function ctx() {
  return { connection };
}

function storedLibrary(): {
  checkedAt: number;
  items: { simkl: number }[];
} {
  return JSON.parse(r2.objects.get(LIBRARY_KEY) ?? "null") as {
    checkedAt: number;
    items: { simkl: number }[];
  };
}

/** Pretend the last activities check is older than the gate. */
function ageLibrary(): void {
  const library = storedLibrary();
  r2.objects.set(
    LIBRARY_KEY,
    JSON.stringify({ ...library, checkedAt: Date.now() - 10 * 60_000 }),
  );
}

beforeEach(() => {
  process.env.SIMKL_CLIENT_ID = "client-123";
  process.env.SIMKL_CLIENT_SECRET = "secret-456";
  r2.objects.clear();
  resetSimklState();
  calls = [];
  routes = defaultRoutes(activities({ all: "2026-10-01T10:00:00Z" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`] as Route | undefined;
    if (!route) return json({ error: "not_found" }, 404);
    const result = await route(call);
    return result instanceof Response ? result : json(result);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("simkl requests", () => {
  it("identify the app on every call", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://api.simkl.com");
      expect(call.url.searchParams.get("client_id")).toBe("client-123");
      expect(call.url.searchParams.get("app-name")).toBe("stremlist");
      expect(call.url.searchParams.get("app-version")).toBe(ADDON_VERSION);
      expect(call.headers.get("simkl-api-key")).toBe("client-123");
      expect(call.headers.get("Authorization")).toBe("Bearer simkl_at_test");
      expect(call.headers.get("User-Agent")).toMatch(/^Stremlist\//);
    }
  });

  it("stay under 10 GET and 1 POST per second", () => {
    expect(limiters).toContainEqual([10, 1000]);
    expect(limiters).toContainEqual([1, 1000]);
  });

  it("treat a rejected token as a lost Connection", async () => {
    routes["GET /sync/activities"] = () =>
      json({ error: "user_token_failed" }, 401);
    await expect(
      simklProvider.fetchSource("me/plantowatch", ctx()),
    ).rejects.toMatchObject({ reason: "needs_connection" });
  });
});

describe("simkl activities gating", () => {
  it("reads the full library once, activities first", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([
      "GET /sync/activities",
      "GET /sync/all-items/shows",
      "GET /sync/all-items/movies",
      "GET /sync/all-items/anime",
    ]);
    const first = calls[1].url.searchParams;
    expect(first.get("extended")).toBe("full_anime_seasons");
    expect(first.get("include_all_episodes")).toBe("yes");
  });

  it("reuses the snapshot inside the gate without any call", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    calls = [];
    await simklProvider.fetchSource("me/completed", ctx());
    await simklProvider.actions?.getMembership(connection);
    expect(calls).toEqual([]);
  });

  it("never calls all-items when activities did not move", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    ageLibrary();
    calls = [];
    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);
    expect(snapshot.entries).toHaveLength(4);
  });

  it("fetches only the delta when a status moved", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    ageLibrary();
    calls = [];
    routes["GET /sync/activities"] = () =>
      activities({
        all: "2026-10-02T08:00:00Z",
        movies: { plantowatch: "2026-10-02T08:00:00Z" },
      });
    routes["GET /sync/all-items"] = () => ({
      movies: [
        {
          added_to_watchlist_at: "2026-10-02T08:00:00Z",
          status: "plantowatch",
          movie: {
            title: "Inception",
            year: 2010,
            ids: { simkl: 472214, imdb: "tt1375666" },
          },
        },
      ],
    });

    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([
      "GET /sync/activities",
      "GET /sync/all-items?date_from=2026-10-01T10:00:00Z",
    ]);
    expect(snapshot.entries.map((entry) => entry.imdbId).at(-1)).toBe(
      "tt1375666",
    );
  });

  it("diffs IDs on removals and reads the ratings delta", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    ageLibrary();
    calls = [];
    routes["GET /sync/activities"] = () =>
      activities({
        all: "2026-10-03T08:00:00Z",
        movies: {
          removed_from_list: "2026-10-03T08:00:00Z",
          rated_at: "2026-10-03T08:00:00Z",
        },
      });
    routes["GET /sync/all-items"] = (call) => {
      expect(call.url.searchParams.get("extended")).toBe("simkl_ids_only");
      // Pulp Fiction (54130) is gone.
      return {
        shows: [297, 17465, 2090].map((simkl) => ({
          show: { ids: { simkl } },
        })),
        anime: [37089, 439744, 2544548].map((simkl) => ({
          show: { ids: { simkl } },
        })),
        movies: [53434, 999].map((simkl) => ({ movie: { ids: { simkl } } })),
      };
    };
    routes["GET /sync/ratings"] = () => ({
      movies: [
        {
          status: "completed",
          user_rating: null,
          movie: { title: "The Godfather", ids: { simkl: 53434 } },
        },
      ],
    });

    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([
      "GET /sync/activities",
      "GET /sync/all-items",
      "GET /sync/ratings?date_from=2026-10-01T10:00:00Z",
    ]);
    expect(snapshot.entries.map((entry) => entry.imdbId)).not.toContain(
      "tt0110912",
    );
    const membership = await simklProvider.actions?.getMembership(connection);
    expect(membership?.ratings).not.toHaveProperty("tt0068646");
  });

  it("falls back to lighter reads when Simkl answers max_items", async () => {
    let attempts = 0;
    routes["GET /sync/all-items/shows"] = (call) => {
      attempts += 1;
      if (call.url.searchParams.get("include_all_episodes") === "yes") {
        return json(
          { error: "max_items", code: 400, message: "Too many episodes" },
          400,
        );
      }
      expect(call.url.searchParams.get("include_all_episodes")).toBe(
        "original",
      );
      return SHOWS;
    };
    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(attempts).toBe(2);
    expect(snapshot.entries).toHaveLength(4);
  });

  it("reads the full library again for another Simkl user", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    calls = [];
    await simklProvider.fetchSource("me/plantowatch", {
      connection: { ...connection, username: "someone-else" },
    });
    expect(apiCalls()).toContain("GET /sync/all-items/shows");
  });
});

describe("simkl entries", () => {
  it("maps statuses to entries, oldest added first", async () => {
    const { entries } = await simklProvider.fetchSource(
      "me/plantowatch",
      ctx(),
    );
    expect(entries).toEqual([
      {
        imdbId: "tt0000999",
        externalIds: { simkl: 999 },
        type: "movie",
        title: "Old Movie",
        year: 1950,
        sourceUrl: "https://simkl.com/movies/999/old-movie",
      },
      {
        imdbId: "tt0158552",
        externalIds: {
          simkl: 297,
          tmdb: { id: 1981, type: "series" },
          tvdb: 70626,
        },
        type: "series",
        title: "Charmed",
        year: 1998,
        sourceUrl: "https://simkl.com/tv/297/charmed",
        addedAt: "2018-02-24T23:55:13Z",
      },
      {
        imdbId: undefined,
        externalIds: { simkl: 2544548, tmdb: { id: 1333100, type: "movie" } },
        type: "movie",
        title: "Attack on Titan: The Last Attack",
        year: 2024,
        sourceUrl: "https://simkl.com/anime/2544548/",
        addedAt: "2025-01-01T00:00:00Z",
      },
      {
        imdbId: "tt0110912",
        externalIds: { simkl: 54130 },
        type: "movie",
        title: "Pulp Fiction",
        year: 1994,
        sourceUrl: "https://simkl.com/movies/54130/pulp-fiction",
        addedAt: "2026-05-14T06:49:56Z",
      },
    ]);
  });

  it("gives anime without an IMDb ID a resolver key", async () => {
    const { entries } = await simklProvider.fetchSource("me/completed", ctx());
    const bebop = entries.find((entry) => entry.title === "Cowboy Bebop");
    expect(bebop).toMatchObject({
      type: "series",
      externalIds: { simkl: 37089, mal: 1 },
    });
    expect(bebop && simklProvider.resolutionKey?.(bebop)).toEqual({
      namespace: "simkl",
      externalId: "37089",
    });
    expect(simklProvider.resolverStrategies?.map((s) => s.name)).toEqual([
      "tmdb-external-ids",
    ]);
  });

  it("needs a Connection for every Source list", async () => {
    await expect(
      simklProvider.fetchSource("me/plantowatch", { connection: null }),
    ).rejects.toMatchObject({ reason: "needs_connection" });
    await expect(
      simklProvider.validateSource("me/watching", { connection: null }),
    ).resolves.toEqual({ ok: false, reason: "needs_connection" });
    await expect(
      simklProvider.validateSource("users/1/watchlist", ctx()),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      simklProvider.validateSource("me/hold", ctx()),
    ).resolves.toMatchObject({ ok: true, ref: "me/hold" });
    expect(calls).toEqual([]);
  });

  it("lists everything watched as history, oldest watch first", async () => {
    const { entries } = await simklProvider.fetchSource("me/history", ctx());
    expect(entries.map((entry) => entry.title)).toEqual([
      "The Godfather",
      "Shingeki no Kyojin Season 2",
      "Cowboy Bebop",
      "Game of Thrones",
      "The Walking Dead",
    ]);
    await expect(
      simklProvider.validateSource("me/history", ctx()),
    ).resolves.toMatchObject({ ok: true, suggestedTitle: "History" });
  });

  it("links every entry back to its Simkl page", async () => {
    const { entries } = await simklProvider.fetchSource("me/completed", ctx());
    expect(entries.map((entry) => entry.sourceUrl)).toContain(
      "https://simkl.com/tv/17465/game-of-thrones",
    );
    expect(entries.every((entry) => entry.sourceUrl)).toBe(true);
  });

  it("builds the link back to a Simkl title page", () => {
    expect(simklItemUrl({ simkl: 17465, kind: "shows", slug: "got" })).toBe(
      "https://simkl.com/tv/17465/got",
    );
    expect(simklItemUrl({ simkl: 53434, kind: "movies" })).toBe(
      "https://simkl.com/movies/53434/",
    );
  });
});

describe("simkl custom lists", () => {
  it("reports premium_only from a 200 body and remembers it", async () => {
    routes["GET /lists/123"] = () => ({
      error: "premium_only",
      message:
        "Custom list items are available to Simkl PRO and VIP members only.",
      item: { title: "Upgrade to Simkl PRO/VIP to unlock this list" },
    });

    const error: unknown = await simklProvider
      .fetchSource("me/lists/123", ctx())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).toMatchObject({ reason: "premium_only" });

    calls = [];
    await expect(
      simklProvider.fetchSource("me/lists/123", ctx()),
    ).rejects.toMatchObject({ reason: "premium_only" });
    expect(apiCalls()).not.toContain("GET /lists/123");

    await expect(
      simklProvider.validateSource("me/lists/123", ctx()),
    ).resolves.toMatchObject({ ok: false, reason: "premium_only" });
  });

  it("reads a PRO list in the owner's order, once per activity change", async () => {
    routes["GET /lists/456"] = (call) => {
      expect(call.url.searchParams.get("limit")).toBe("500");
      return {
        id: 456,
        name: "Best 90s sci-fi",
        type: "regular",
        media_type: "movies",
        pagination: { page: 1, limit: 500, total_items: 2, total_pages: 1 },
        items: [
          {
            title: "Ghost in the Shell",
            year: 1995,
            type: "anime",
            anime_type: "movie",
            ids: { simkl_id: 53536, imdb: "tt0113568", mal: "43" },
            position: 1,
          },
          {
            title: "The Matrix",
            year: 1999,
            type: "movie",
            ids: { simkl_id: 53992, tmdb: "603" },
            position: 2,
          },
        ],
      };
    };

    const { entries, complete } = await simklProvider.fetchSource(
      "me/lists/456",
      ctx(),
    );
    expect(complete).toBe(true);
    expect(entries).toEqual([
      {
        imdbId: "tt0113568",
        externalIds: { simkl: 53536, mal: 43 },
        type: "movie",
        title: "Ghost in the Shell",
        year: 1995,
        sourceUrl: "https://simkl.com/anime/53536/",
      },
      {
        imdbId: undefined,
        externalIds: { simkl: 53992, tmdb: { id: 603, type: "movie" } },
        type: "movie",
        title: "The Matrix",
        year: 1999,
        sourceUrl: "https://simkl.com/movies/53992/",
      },
    ]);

    ageLibrary();
    calls = [];
    await simklProvider.fetchSource("me/lists/456", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);

    ageLibrary();
    calls = [];
    routes["GET /sync/activities"] = () =>
      activities({
        all: "2026-10-04T00:00:00Z",
        lists: "2026-10-04T00:00:00Z",
      });
    await simklProvider.fetchSource("me/lists/456", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities", "GET /lists/456"]);
  });

  it("marks a list cut by the page cap as incomplete, also from its snapshot", async () => {
    routes["GET /lists/321"] = (call) => ({
      id: 321,
      name: "Everything",
      type: "regular",
      media_type: "movies",
      pagination: { page: 1, limit: 500, total_items: 20_000, total_pages: 40 },
      items: [
        {
          title: `Movie ${call.url.searchParams.get("page")}`,
          type: "movie",
          ids: {
            simkl_id: Number(call.url.searchParams.get("page")),
            imdb: `tt${String(call.url.searchParams.get("page")).padStart(7, "0")}`,
          },
        },
      ],
    });

    const first = await simklProvider.fetchSource("me/lists/321", ctx());
    expect(first.entries).toHaveLength(20);
    expect(first.complete).toBe(false);

    // The next read comes from the stored snapshot and keeps the flag.
    ageLibrary();
    calls = [];
    const second = await simklProvider.fetchSource("me/lists/321", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);
    expect(second.complete).toBe(false);
  });

  it("validates a list with its name and media type", async () => {
    routes["GET /lists/789"] = () => ({
      id: 789,
      name: "Weekend shows",
      media_type: "tv",
      items: [],
    });
    await expect(
      simklProvider.validateSource("me/lists/789", ctx()),
    ).resolves.toEqual({
      ok: true,
      ref: "me/lists/789",
      suggestedTitle: "Weekend shows",
      defaultDisplayMode: "series",
    });
    routes["GET /lists/790"] = () => json({ error: "private_list" }, 403);
    await expect(
      simklProvider.validateSource("me/lists/790", ctx()),
    ).resolves.toMatchObject({ ok: false, reason: "private" });
  });
});

describe("simkl actions", () => {
  const actions = simklProvider.actions;
  if (!actions) throw new Error("Simkl must support Actions");

  function lastPost(): { path: string; body: unknown; headers: Headers } {
    const post = calls.filter((call) => call.method === "POST").at(-1);
    if (!post) throw new Error("no POST");
    return {
      path: post.url.pathname,
      body: JSON.parse(post.body ?? "null"),
      headers: post.headers,
    };
  }

  function acceptWrites(): void {
    for (const path of [
      "/sync/add-to-list",
      "/sync/history",
      "/sync/history/remove",
      "/sync/ratings",
      "/sync/ratings/remove",
    ]) {
      routes[`POST ${path}`] = () =>
        json({ added: {}, not_found: { movies: [], shows: [] } }, 201);
    }
  }

  it("derives membership from the same library", async () => {
    const membership = await actions.getMembership(connection);
    expect(new Set(membership.watchlist)).toEqual(
      new Set(["tt0000999", "tt0158552", "tt0110912"]),
    );
    expect(new Set(membership.watched)).toEqual(
      new Set(["tt0944947", "tt1520211", "tt0068646", "tt2560140"]),
    );
    expect(new Set(membership.watchedEpisodes)).toEqual(
      new Set([
        "tt0944947:1:1",
        "tt0944947:1:2",
        "tt1520211:1:2",
        // AniDB episode 1 of the Season 2 entry is TVDB (IMDb) S2E1.
        "tt2560140:2:1",
      ]),
    );
    expect(membership.ratings).toEqual({ tt0944947: 9, tt0068646: 10 });
  });

  it("adds to plan to watch", async () => {
    acceptWrites();
    await actions.perform(
      connection,
      { kind: "watchlist", add: true },
      { imdbId: "tt1375666", type: "movie" },
    );
    const post = lastPost();
    expect(post.path).toBe("/sync/add-to-list");
    expect(post.headers.get("Content-Type")).toBe("application/json");
    expect(post.headers.get("Authorization")).toBe("Bearer simkl_at_test");
    expect(post.body).toEqual({
      movies: [{ ids: { imdb: "tt1375666" }, to: "plantowatch" }],
    });
  });

  it("removes a planned title, but never a watched one", async () => {
    acceptWrites();
    await actions.getMembership(connection);

    await actions.perform(
      connection,
      { kind: "watchlist", add: false },
      { imdbId: "tt0158552", type: "series" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/history/remove",
      body: { shows: [{ ids: { imdb: "tt0158552" } }] },
    });

    calls = [];
    await actions.perform(
      connection,
      { kind: "watchlist", add: false },
      { imdbId: "tt0068646", type: "movie" },
    );
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("marks episodes, shows and movies as watched", async () => {
    acceptWrites();
    await actions.perform(
      connection,
      { kind: "watched", add: true },
      {
        imdbId: "tt2560140",
        type: "series",
        episode: { season: 2, episode: 4 },
      },
    );
    expect(lastPost()).toEqual(
      expect.objectContaining({
        path: "/sync/history",
        body: {
          shows: [
            {
              ids: { imdb: "tt2560140" },
              use_tvdb_anime_seasons: true,
              seasons: [{ number: 2, episodes: [{ number: 4 }] }],
            },
          ],
        },
      }),
    );

    await actions.perform(
      connection,
      { kind: "watched", add: true },
      { imdbId: "tt0944947", type: "series" },
    );
    expect(lastPost().body).toEqual({
      shows: [{ ids: { imdb: "tt0944947" }, status: "completed" }],
    });

    await actions.perform(
      connection,
      { kind: "watched", add: false },
      { imdbId: "tt0068646", type: "movie" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/history/remove",
      body: { movies: [{ ids: { imdb: "tt0068646" } }] },
    });
  });

  it("unmarks a show season by season and keeps it in the library", async () => {
    acceptWrites();
    await actions.getMembership(connection);
    await actions.perform(
      connection,
      { kind: "watched", add: false },
      { imdbId: "tt0944947", type: "series" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/history/remove",
      body: {
        shows: [
          {
            ids: { imdb: "tt0944947" },
            use_tvdb_anime_seasons: true,
            seasons: [{ number: 1 }],
          },
        ],
      },
    });
  });

  it("rates and removes ratings", async () => {
    acceptWrites();
    await actions.perform(
      connection,
      { kind: "rating", rating: 8 },
      { imdbId: "tt0944947", type: "series" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/ratings",
      body: { shows: [{ ids: { imdb: "tt0944947" }, rating: 8 }] },
    });
    await actions.perform(
      connection,
      { kind: "rating", rating: null },
      { imdbId: "tt0068646", type: "movie" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/ratings/remove",
      body: { movies: [{ ids: { imdb: "tt0068646" } }] },
    });
    await expect(
      actions.perform(
        connection,
        { kind: "rating", rating: 11 },
        { imdbId: "tt0068646", type: "movie" },
      ),
    ).rejects.toThrow();
  });

  it("fails when Simkl does not know the title", async () => {
    routes["POST /sync/history"] = () =>
      json(
        {
          added: { movies: 0 },
          not_found: { movies: [{ ids: { imdb: "tt9999999" } }], shows: [] },
        },
        201,
      );
    await expect(
      actions.perform(
        connection,
        { kind: "watched", add: true },
        { imdbId: "tt9999999", type: "movie" },
      ),
    ).rejects.toThrow(/tt9999999/);
  });

  it("checks activities again on the next read after an Action", async () => {
    acceptWrites();
    await simklProvider.fetchSource("me/plantowatch", ctx());
    await actions.perform(
      connection,
      { kind: "watchlist", add: true },
      { imdbId: "tt1375666", type: "movie" },
    );
    expect(storedLibrary().checkedAt).toBe(0);
    calls = [];
    await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);
  });

  it("marks every library list stale, since a title has one status", () => {
    const all = [
      "me/watching",
      "me/plantowatch",
      "me/hold",
      "me/completed",
      "me/dropped",
      "me/history",
    ];
    expect(actions.kinds).toEqual(["watchlist", "watched", "rating"]);
    expect(actions.affectedSources({ kind: "watchlist", add: true })).toEqual(
      all,
    );
    expect(actions.affectedSources({ kind: "watched", add: false })).toEqual(
      all,
    );
    expect(actions.affectedSources({ kind: "rating", rating: 5 })).toEqual(all);
  });
});

describe("simkl oauth", () => {
  const oauth = simklProvider.oauth;
  if (!oauth) throw new Error("Simkl must use OAuth");

  it("uses AUTH V2 with explicit write scope", () => {
    expect(oauth.authorizeUrl).toBe("https://simkl.com/oauth2/authorize");
    expect(oauth.tokenUrl).toBe("https://api.simkl.com/oauth2/token");
    expect(oauth.scopes).toEqual(["media:read", "media:write"]);
    expect(oauth.clientId()).toBe("client-123");
    expect(oauth.clientSecret?.()).toBe("secret-456");
    process.env.SIMKL_CLIENT_ID = " ";
    expect(oauth.clientId()).toBeUndefined();
  });

  it("reads the username from the user settings", async () => {
    routes["GET /users/settings"] = () => ({
      user: { name: "leo-simkl", joined_at: "2018-01-15T00:00:00Z" },
      account: { id: 12345, timezone: "Europe/Paris", type: "free" },
    });
    await expect(oauth.fetchUsername?.("simkl_at_new")).resolves.toBe(
      "leo-simkl",
    );
    expect(calls[0].headers.get("Authorization")).toBe("Bearer simkl_at_new");
  });

  it("revokes the grant with the client credentials", async () => {
    routes["POST /oauth2/revoke"] = () => ({});
    await oauth.revoke?.("simkl_at_old");
    const call = calls[0];
    expect(call.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      client_id: "client-123",
      client_secret: "secret-456",
      token: "simkl_at_old",
    });
  });
});
