import { parseSourceLink } from "@stremlist/shared/providers";
import { http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  unexpectedRequest,
  useMswServer,
} from "../../test/helpers/msw.test-utils";
import { listMdblistUserSources, mdblistProvider } from "../mdblist";
import type { ActionIntent, ActionTarget, ConnectionAccess } from "../types";
import { ConnectionExpiredError, SourceUnavailableError } from "../types";

const SUPER_MARIO = {
  id: 502356,
  mediatype: "movie",
  imdb_id: "tt6718170",
  tvdb_id: 136578,
  ids: { mdblist: "3446", imdb: "tt6718170", tmdb: 502356, tvdb: 136578 },
  title: "The Super Mario Bros. Movie",
  release_year: 2023,
  runtime: 93,
  added_at: "2026-10-04T13:00:10",
  rank: 8,
};
const BREAKING_BAD = {
  id: 1396,
  mediatype: "show",
  imdb_id: "tt0903747",
  tvdb_id: 81189,
  ids: { mdblist: "8plj", imdb: "tt0903747", tmdb: 1396, tvdb: 81189 },
  title: "Breaking Bad",
  release_year: 2008,
  runtime: 2995,
  watchlist_at: "2026-10-05T23:46:06.700Z",
};
const SHAWSHANK = {
  id: 278,
  mediatype: "movie",
  imdb_id: "tt0111161",
  ids: { mdblist: "a0", imdb: "tt0111161", tmdb: 278, tvdb: 190 },
  title: "The Shawshank Redemption",
  release_year: 1994,
  runtime: 142,
  watchlist_at: "2026-10-05T23:46:06.689Z",
};
const NO_IMDB = {
  id: 1234567,
  mediatype: "show",
  imdb_id: null,
  ids: { mdblist: "zz1", imdb: null, tmdb: 1234567, tvdb: null },
  title: "Fresh Anime",
  release_year: 2026,
};
const EPISODE_ITEM = { id: 62085, mediatype: "episode", title: "Pilot" };
const RATED_SHAWSHANK = {
  title: "The Shawshank Redemption",
  ids: { imdb: "tt0111161", tmdb: 278, trakt: 234, mdblist: "a0" },
};
const RATED_BREAKING_BAD = {
  title: "Breaking Bad",
  ids: { imdb: "tt0903747", tmdb: 1396, tvdb: 81189, mdblist: "8plj" },
};

const SUPPORTER_ONLY = () =>
  Response.json(
    { error: "This section requires a supporter subscription." },
    { status: 403 },
  );

interface Call {
  url: URL;
  init: { method: string; headers: Headers; body: string | undefined };
}

let calls: Call[];
let handler: (url: URL) => Response;
let method = "GET";
let handlerErrors: unknown[] = [];

function noAnswer(url: URL): never {
  throw new Error(`The test sets no MDBList answer for ${url.href}`);
}

function itemsPage(items: unknown[], nextCursor?: string) {
  return Response.json(items, {
    headers: nextCursor
      ? { "X-Has-More": "true", "X-Next-Cursor": nextCursor }
      : { "X-Has-More": "false" },
  });
}

function connection(username: string | null = "leo") {
  const value: ConnectionAccess = {
    accountId: "sl_testaccount0000000000",
    provider: "mdblist",
    username,
    authorization: "authorization-1",
    getAccessToken: () => Promise.resolve("user-token"),
    reportRefused: () => Promise.resolve(),
    reportWorking: () => Promise.resolve(),
  };
  return value;
}

function defined<T>(value: T | undefined) {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

function textBody(call: Call) {
  if (typeof call.init.body !== "string") {
    throw new Error("Expected a text request body");
  }
  return call.init.body;
}

function bodyOf(call: Call) {
  const body: unknown = JSON.parse(textBody(call));
  return body;
}

const server = useMswServer();

beforeEach(() => {
  calls = [];
  handlerErrors = [];
  handler = noAnswer;
  method = "GET";
  server.use(
    http.all(/^https:\/\/(?:[a-z]+\.)?mdblist\.com\//, async ({ request }) => {
      const url = new URL(request.url);
      const text = await request.text();
      calls.push({
        url,
        init: {
          method: request.method,
          headers: request.headers,
          body: text === "" ? undefined : text,
        },
      });
      if (request.method !== method) {
        return unexpectedRequest(request, `the test answers ${method} only`);
      }
      try {
        return handler(url);
      } catch (error) {
        handlerErrors.push(error);
        return new Response("The test handler failed", { status: 599 });
      }
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (handlerErrors.length > 0) {
    throw new AggregateError(handlerErrors, "A test handler failed");
  }
});

describe("parseSourceLink (MDBList)", () => {
  it("reads list links by owner and slug", () => {
    expect(
      parseSourceLink(
        "https://mdblist.com/lists/Linaspurinis/top-watched-movies-of-the-week/",
      ),
    ).toEqual({
      provider: "mdblist",
      sourceRef: "lists/Linaspurinis/top-watched-movies-of-the-week",
      kind: "list",
    });
  });

  it("reads watchlist links", () => {
    expect(parseSourceLink("mdblist.com/watchlist/leo")).toMatchObject({
      provider: "mdblist",
      sourceRef: "watchlist/leo",
      kind: "watchlist",
    });
  });

  it.each([
    "https://mdblist.com/lists/official/movies/justwatch-streaming-charts",
    "https://mdblist.com/movie/2xwba-the-love-hypothesis",
  ])("ignores %s", (link) => {
    expect(parseSourceLink(link)).toBeNull();
  });
});

describe("mdblistProvider.validateSource", () => {
  it("needs a Connection", async () => {
    await expect(
      mdblistProvider.validateSource("lists/leo/my-list", { connection: null }),
    ).resolves.toMatchObject({ ok: false, reason: "needs_connection" });
    expect(calls).toHaveLength(0);
  });

  it("resolves an owner and slug to the numeric list ID", async () => {
    handler = () =>
      Response.json([
        {
          id: 14,
          user_name: "linaspurinis",
          name: "Top Watched Movies of The Week / >60",
          slug: "top-watched-movies-of-the-week",
          mediatype: "movie",
          private: false,
        },
      ]);
    const result = await mdblistProvider.validateSource(
      "lists/linaspurinis/top-watched-movies-of-the-week",
      { connection: connection() },
    );
    expect(result).toEqual({
      ok: true,
      ref: "lists/14",
      suggestedTitle: "Top Watched Movies of The Week / >60",
      defaultDisplayMode: "movie",
    });
    expect(calls[0].url.toString()).toBe(
      "https://api.mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week",
    );
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer user-token");
    expect(calls[0].url.searchParams.has("apikey")).toBe(false);
  });

  it("keeps the user's own lists and external lists under me/", async () => {
    handler = (url) =>
      url.pathname.startsWith("/external/")
        ? Response.json({
            id: 77,
            name: "Letterboxd watchlist",
            mediatype: "movie",
          })
        : Response.json({ id: 42, name: "Mixed", mediatype: null });
    const ctx = { connection: connection() };
    await expect(
      mdblistProvider.validateSource("me/lists/42", ctx),
    ).resolves.toMatchObject({
      ok: true,
      ref: "me/lists/42",
      defaultDisplayMode: "split",
    });
    await expect(
      mdblistProvider.validateSource("me/external/77", ctx),
    ).resolves.toMatchObject({
      ok: true,
      ref: "me/external/77",
      suggestedTitle: "Letterboxd watchlist",
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/lists/42",
      "/external/lists/77",
    ]);
  });

  it("accepts only the connected user's own watchlist link", async () => {
    const ctx = { connection: connection("leo") };
    await expect(
      mdblistProvider.validateSource("watchlist/LEO", ctx),
    ).resolves.toMatchObject({ ok: true, ref: "me/watchlist" });
    await expect(
      mdblistProvider.validateSource("watchlist/someone", ctx),
    ).resolves.toMatchObject({ ok: false, reason: "private" });
    expect(calls).toHaveLength(0);
  });

  it("maps a missing list to not_found", async () => {
    handler = () => Response.json({ error: "Not found" }, { status: 404 });
    await expect(
      mdblistProvider.validateSource("lists/leo/nope", {
        connection: connection(),
      }),
    ).rejects.toMatchObject({
      name: "SourceUnavailableError",
      reason: "not_found",
    });
  });

  it("accepts the ratings and the history with no read", async () => {
    const ctx = { connection: connection() };
    await expect(
      mdblistProvider.validateSource("me/ratings", ctx),
    ).resolves.toEqual({
      ok: true,
      ref: "me/ratings",
      suggestedTitle: "MDBList ratings",
      defaultDisplayMode: "split",
    });
    await expect(
      mdblistProvider.validateSource("me/history", ctx),
    ).resolves.toMatchObject({ ok: true, ref: "me/history" });
    expect(calls).toHaveLength(0);
  });

  it("names an official chart from its info", async () => {
    handler = () =>
      Response.json([
        {
          id: 3,
          user_id: 1,
          user_name: "mdblist",
          name: "Trending",
          slug: "trending",
          media: "movie,show",
          mediatype: null,
          description: "",
          updated: "2026-11-16T00:00:00Z",
          items: 200,
          movies: 100,
          shows: 100,
          url: "https://mdblist.com/lists/official/trending",
          source: "mdblist",
          private: false,
        },
      ]);
    await expect(
      mdblistProvider.validateSource("official/trending", {
        connection: connection(),
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "official/trending",
      suggestedTitle: "Trending",
      defaultDisplayMode: "split",
    });
    expect(calls[0].url.pathname).toBe("/lists/official/trending");
  });

  it("accepts Up Next and the collection with no read", async () => {
    const ctx = { connection: connection() };
    await expect(
      mdblistProvider.validateSource("me/up-next", ctx),
    ).resolves.toEqual({
      ok: true,
      ref: "me/up-next",
      suggestedTitle: "MDBList Up Next",
      defaultDisplayMode: "series",
    });
    await expect(
      mdblistProvider.validateSource("me/collection", ctx),
    ).resolves.toMatchObject({ ok: true, ref: "me/collection" });
    expect(calls).toHaveLength(0);
  });

  it("names a recommendation section from its info", async () => {
    handler = () =>
      Response.json({
        slug: "rising",
        label: "Rising Fast",
        description: "Accelerating in popularity right now",
        items_url: "/lists/recommended/rising/items",
      });
    await expect(
      mdblistProvider.validateSource("recommended/rising", {
        connection: connection(),
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "recommended/rising",
      suggestedTitle: "Rising Fast",
      defaultDisplayMode: "split",
    });
    expect(calls[0].url.pathname).toBe("/lists/recommended/rising");
  });

  it("says that a supporter section needs a paid plan", async () => {
    handler = SUPPORTER_ONLY;
    await expect(
      mdblistProvider.validateSource("recommended/because-watched", {
        connection: connection(),
      }),
    ).rejects.toMatchObject({ reason: "premium_only" });
  });

  it("rejects unknown refs", async () => {
    await expect(
      mdblistProvider.validateSource("users/leo", { connection: connection() }),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("mdblistProvider.fetchSource", () => {
  const ctx = () => ({ connection: connection() });

  it("follows X-Next-Cursor and keeps the list order", async () => {
    handler = (url) =>
      url.searchParams.get("cursor")
        ? itemsPage([NO_IMDB, BREAKING_BAD])
        : itemsPage([SUPER_MARIO, EPISODE_ITEM], "page-2");
    const snapshot = await mdblistProvider.fetchSource("lists/14", ctx());

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/lists/14/items",
      "/lists/14/items",
    ]);
    expect(calls[0].url.searchParams.get("unified")).toBe("true");
    expect(calls[0].url.searchParams.get("limit")).toBe("1000");
    expect(calls[1].url.searchParams.get("cursor")).toBe("page-2");
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries).toEqual([
      {
        type: "movie",
        imdbId: "tt6718170",
        externalIds: { tmdb: { id: 502356, type: "movie" } },
        title: "The Super Mario Bros. Movie",
        year: 2023,
        runtimeMinutes: 93,
      },
      {
        type: "series",
        externalIds: { tmdb: { id: 1234567, type: "series" } },
        title: "Fresh Anime",
        year: 2026,
      },
      {
        type: "series",
        imdbId: "tt0903747",
        externalIds: { tmdb: { id: 1396, type: "series" } },
        title: "Breaking Bad",
        year: 2008,
      },
    ]);
  });

  it("stops when the cursor repeats", async () => {
    handler = () => itemsPage([SUPER_MARIO], "same");
    const snapshot = await mdblistProvider.fetchSource("lists/14", ctx());
    expect(calls).toHaveLength(2);
    expect(snapshot.complete).toBe(false);
  });

  it("marks a list cut by the page cap as incomplete", async () => {
    handler = () => itemsPage([SUPER_MARIO], `page-${calls.length}`);
    const snapshot = await mdblistProvider.fetchSource("lists/14", ctx());
    expect(calls).toHaveLength(50);
    expect(snapshot.complete).toBe(false);
  });

  it("reads the watchlist oldest added first", async () => {
    handler = () => itemsPage([BREAKING_BAD, SHAWSHANK]);
    const snapshot = await mdblistProvider.fetchSource("me/watchlist", ctx());
    expect(calls[0].url.pathname).toBe("/watchlist/items");
    expect(snapshot.entries.map((entry) => entry.imdbId)).toEqual([
      "tt0111161",
      "tt0903747",
    ]);
  });

  it("reads lists by slug, own lists and external lists", async () => {
    handler = () => itemsPage([]);
    for (const ref of ["lists/leo/my-list", "me/lists/42", "me/external/77"]) {
      await mdblistProvider.fetchSource(ref, ctx());
    }
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/lists/leo/my-list/items",
      "/lists/42/items",
      "/external/lists/77/items",
    ]);
  });

  it.each([
    [401, { error: "Unauthorized" }, "needs_connection"],
    [403, { error: "Invalid OAuth token" }, "needs_connection"],
    [403, { error: "List is private" }, "private"],
    [404, { error: "List Not found" }, "not_found"],
  ])("maps HTTP %i %j to %s", async (status, body, reason) => {
    handler = () => Response.json(body, { status });
    const error = await mdblistProvider
      .fetchSource("lists/14", ctx())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).toHaveProperty("reason", reason);
  });

  it("lets an expired Connection through, for the caller to ask for renewal", async () => {
    const expired = new ConnectionExpiredError("mdblist");
    const access = {
      ...connection(),
      getAccessToken: () => Promise.reject(expired),
    };
    await expect(
      mdblistProvider.fetchSource("me/watchlist", { connection: access }),
    ).rejects.toBe(expired);
    expect(calls).toHaveLength(0);
  });

  it("does not treat server errors as an expected state", async () => {
    handler = () => Response.json({ error: "boom" }, { status: 502 });
    const error = await mdblistProvider
      .fetchSource("lists/14", ctx())
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("needs a Connection", async () => {
    await expect(
      mdblistProvider.fetchSource("me/watchlist", { connection: null }),
    ).rejects.toMatchObject({ reason: "needs_connection" });
  });

  it("reads the ratings oldest rated first, dated by rating", async () => {
    handler = (url) =>
      url.searchParams.get("cursor")
        ? Response.json({
            movies: [{ rating: 6, movie: { ids: { imdb: "tt6718170" } } }],
            shows: [],
            seasons: [],
            episodes: [],
            pagination: { has_more: false, next_cursor: null },
          })
        : Response.json({
            movies: [
              {
                rated_at: "2026-10-02T10:00:00Z",
                rating: 8,
                rating_precise: 8,
                movie: RATED_SHAWSHANK,
              },
            ],
            shows: [
              {
                rated_at: "2026-10-01T10:00:00Z",
                rating: 9,
                rating_precise: 9,
                show: RATED_BREAKING_BAD,
              },
            ],
            seasons: [],
            episodes: [
              {
                rated_at: "2026-10-03T10:00:00Z",
                rating: 7,
                episode: {
                  season: 1,
                  number: 1,
                  show: { ids: { imdb: "tt0903747", tmdb: 1396 } },
                },
              },
            ],
            pagination: { has_more: true, next_cursor: "r2" },
          });
    const snapshot = await mdblistProvider.fetchSource("me/ratings", ctx());

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/sync/ratings",
      "/sync/ratings",
    ]);
    expect(calls[1].url.searchParams.get("cursor")).toBe("r2");
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries).toEqual([
      {
        type: "series",
        imdbId: "tt0903747",
        externalIds: { tmdb: { id: 1396, type: "series" } },
        title: "Breaking Bad",
        addedAt: "2026-10-01T10:00:00Z",
      },
      {
        type: "movie",
        imdbId: "tt0111161",
        externalIds: { tmdb: { id: 278, type: "movie" } },
        title: "The Shawshank Redemption",
        addedAt: "2026-10-02T10:00:00Z",
      },
      { type: "movie", imdbId: "tt6718170" },
    ]);
  });

  it("reads the history by last watch, with shows from their seasons", async () => {
    handler = (url) =>
      Response.json(
        url.searchParams.get("mediatype") === "movie"
          ? {
              movies: [
                {
                  last_watched_at: "2026-10-05T20:00:00.000Z",
                  movie: RATED_SHAWSHANK,
                },
              ],
              shows: [],
              seasons: [],
              episodes: [],
              pagination: { offset: 0, limit: 1000, has_more: false },
            }
          : {
              movies: [],
              shows: [],
              seasons: [
                {
                  last_watched_at: "2026-10-01T20:00:00.000Z",
                  season: { number: 1, show: RATED_BREAKING_BAD },
                },
                {
                  last_watched_at: "2026-10-04T20:00:00.000Z",
                  season: { number: 2, show: RATED_BREAKING_BAD },
                },
              ],
              episodes: [],
              pagination: { offset: 0, limit: 1000, has_more: false },
            },
      );
    const snapshot = await mdblistProvider.fetchSource("me/history", ctx());

    expect(
      calls.map((call) => [
        call.url.pathname,
        call.url.searchParams.get("mediatype"),
      ]),
    ).toEqual([
      ["/sync/watched", "movie"],
      ["/sync/watched", "season"],
    ]);
    expect(
      snapshot.entries.map((entry) => [entry.imdbId, entry.addedAt]),
    ).toEqual([
      ["tt0903747", "2026-10-04T20:00:00.000Z"],
      ["tt0111161", "2026-10-05T20:00:00.000Z"],
    ]);
    expect(snapshot.complete).toBe(true);
  });

  it("marks a sync read cut by the page cap as incomplete", async () => {
    handler = () =>
      Response.json({
        movies: [{ rated_at: "2026-10-01T10:00:00Z", movie: RATED_SHAWSHANK }],
        pagination: { has_more: true, next_cursor: `page-${calls.length}` },
      });
    const snapshot = await mdblistProvider.fetchSource("me/ratings", ctx());
    expect(calls).toHaveLength(50);
    expect(snapshot.complete).toBe(false);
  });

  it("reads an official chart in MDBList's order, undated", async () => {
    handler = () => itemsPage([SUPER_MARIO, BREAKING_BAD]);
    const snapshot = await mdblistProvider.fetchSource(
      "official/trending",
      ctx(),
    );
    expect(calls[0].url.pathname).toBe("/lists/official/trending/items");
    expect(calls[0].url.searchParams.get("unified")).toBe("true");
    expect(
      snapshot.entries.map((entry) => [entry.imdbId, entry.addedAt]),
    ).toEqual([
      ["tt6718170", undefined],
      ["tt0903747", undefined],
    ]);
  });

  it("reads a recommendation section as a list, undated", async () => {
    handler = () => itemsPage([BREAKING_BAD, SUPER_MARIO]);
    const snapshot = await mdblistProvider.fetchSource(
      "recommended/rising",
      ctx(),
    );
    expect(calls[0].url.pathname).toBe("/lists/recommended/rising/items");
    expect(calls[0].url.searchParams.get("unified")).toBe("true");
    expect(
      snapshot.entries.map((entry) => [entry.imdbId, entry.addedAt]),
    ).toEqual([
      ["tt0903747", undefined],
      ["tt6718170", undefined],
    ]);
  });

  it("gives premium_only, not a server error, for a supporter section", async () => {
    handler = SUPPORTER_ONLY;
    const error: unknown = await mdblistProvider
      .fetchSource("recommended/because-watched", ctx())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).toMatchObject({ reason: "premium_only" });
  });

  it("reads Up Next by offset, oldest watched first, undated", async () => {
    const row = (show: unknown, at: string | null) => ({
      show,
      next_episode: { season: 1, episode: 2, display_code: "S01E02" },
      progress: { watched_episode_count: 1, total_episode_count: 62 },
      last_watched_at: at,
      is_newly_aired: false,
    });
    handler = (url) =>
      Response.json(
        url.searchParams.get("offset") === "0"
          ? {
              items: [
                row(
                  { ...RATED_BREAKING_BAD, year: 2008 },
                  "2026-11-10T20:00:00.000Z",
                ),
              ],
              limit: 100,
              has_more: true,
            }
          : {
              items: [
                row(
                  {
                    title: "Severance",
                    year: 2022,
                    ids: { imdb: "tt11280740", tmdb: 95396 },
                  },
                  "2026-11-01T20:00:00.000Z",
                ),
              ],
              limit: 100,
              has_more: false,
            },
      );
    const snapshot = await mdblistProvider.fetchSource("me/up-next", ctx());
    expect(
      calls.map((call) => [
        call.url.pathname,
        call.url.searchParams.get("limit"),
        call.url.searchParams.get("offset"),
      ]),
    ).toEqual([
      ["/upnext", "100", "0"],
      ["/upnext", "100", "1"],
    ]);
    expect(snapshot.entries).toEqual([
      {
        type: "series",
        imdbId: "tt11280740",
        externalIds: { tmdb: { id: 95396, type: "series" } },
        title: "Severance",
        year: 2022,
      },
      {
        type: "series",
        imdbId: "tt0903747",
        externalIds: { tmdb: { id: 1396, type: "series" } },
        title: "Breaking Bad",
        year: 2008,
      },
    ]);
    expect(snapshot.complete).toBe(true);
  });

  it("reads the collection, with partly collected shows from their episodes", async () => {
    const GAME_OF_THRONES = {
      title: "Game of Thrones",
      year: 2011,
      ids: { imdb: "tt0944947", tmdb: 1399, tvdb: 121361, mdblist: "8pll" },
    };
    const empty = { movies: [], shows: [], seasons: [], episodes: [] };
    const pagination = { offset: 0, limit: 1000, has_more: false };
    const episode = (show: unknown, number: number, collectedAt: string) => ({
      collected_at: collectedAt,
      episode: { season: 1, number, ids: { tmdb: number }, show },
    });
    handler = (url) => {
      switch (url.searchParams.get("mediatype") ?? "") {
        case "movie":
          return Response.json({
            ...empty,
            movies: [
              {
                collected_at: "2026-11-03T10:00:00.000Z",
                movie: RATED_SHAWSHANK,
              },
            ],
            pagination,
          });
        case "show":
          return Response.json({
            ...empty,
            shows: [
              {
                collected_at: "2026-11-05T10:00:00.000Z",
                show: GAME_OF_THRONES,
              },
            ],
            pagination,
          });
        default:
          return Response.json({
            ...empty,
            episodes: [
              episode(GAME_OF_THRONES, 1, "2026-11-05T10:00:00.000Z"),
              episode(RATED_BREAKING_BAD, 2, "2026-11-02T10:00:00.000Z"),
              episode(RATED_BREAKING_BAD, 1, "2026-11-01T10:00:00.000Z"),
            ],
            pagination,
          });
      }
    };
    const snapshot = await mdblistProvider.fetchSource("me/collection", ctx());
    expect(
      calls.map((call) => [
        call.url.pathname,
        call.url.searchParams.get("mediatype"),
      ]),
    ).toEqual([
      ["/sync/collection", "movie"],
      ["/sync/collection", "show"],
      ["/sync/collection", "episode"],
    ]);
    expect(
      snapshot.entries.map((entry) => [
        entry.imdbId,
        entry.type,
        entry.addedAt,
      ]),
    ).toEqual([
      ["tt0903747", "series", "2026-11-01T10:00:00.000Z"],
      ["tt0111161", "movie", "2026-11-03T10:00:00.000Z"],
      ["tt0944947", "series", "2026-11-05T10:00:00.000Z"],
    ]);
    expect(snapshot.complete).toBe(true);
  });
});

describe("mdblistProvider.resolutionKey", () => {
  it("keys entries by TMDB ID and media type", () => {
    expect(
      mdblistProvider.resolutionKey?.({
        type: "series",
        externalIds: { tmdb: { id: 1234567, type: "series" } },
      }),
    ).toEqual({ namespace: "mdblist-show", externalId: "1234567" });
    expect(
      mdblistProvider.resolutionKey?.({
        type: "movie",
        externalIds: { tmdb: { id: 278, type: "movie" } },
      }),
    ).toEqual({ namespace: "mdblist-movie", externalId: "278" });
    expect(mdblistProvider.resolutionKey?.({ type: "movie" })).toBeNull();
  });

  it("resolves through TMDB external IDs", () => {
    expect(mdblistProvider.resolverStrategies?.map((s) => s.name)).toEqual([
      "tmdb-external-ids",
    ]);
  });
});

describe("mdblistProvider.actions", () => {
  const actions = defined(mdblistProvider.actions);
  const synced = {
    updated: { movies: 1 },
    not_found: { movies: [], shows: [] },
  };
  const movie: ActionTarget = { imdbId: "tt0111161", type: "movie" };
  const episode = (season: number, number: number) =>
    ({
      imdbId: "tt0903747",
      type: "series",
      episode: { season, episode: number },
    }) satisfies ActionTarget;
  const movieBody = { movies: [{ ids: { imdb: "tt0111161" } }] };
  const episodeBody = {
    shows: [
      {
        ids: { imdb: "tt0903747" },
        seasons: [{ number: 1, episodes: [{ number: 1 }] }],
      },
    ],
  };

  it.each<[string, ActionIntent, ActionTarget, unknown, string, unknown]>([
    [
      "adds a movie to the watchlist",
      { kind: "watchlist", add: true },
      movie,
      { added: { movies: 1, shows: 0 }, not_found: { movies: 0, shows: 0 } },
      "/watchlist/items/add",
      movieBody,
    ],
    [
      "removes the series, not the episode, from the watchlist",
      { kind: "watchlist", add: false },
      episode(1, 2),
      { removed: { movies: 0, shows: 0 }, not_found: { movies: 0, shows: 1 } },
      "/watchlist/items/remove",
      { shows: [{ ids: { imdb: "tt0903747" } }] },
    ],
    [
      "marks one episode as watched",
      { kind: "watched", add: true },
      episode(1, 1),
      synced,
      "/sync/watched",
      episodeBody,
    ],
    [
      "marks one episode as unwatched",
      { kind: "watched", add: false },
      episode(1, 1),
      synced,
      "/sync/watched/remove",
      episodeBody,
    ],
    [
      "marks a whole movie as watched",
      { kind: "watched", add: true },
      movie,
      synced,
      "/sync/watched",
      movieBody,
    ],
    [
      "dates a watched movie with the time Stremio gives",
      { kind: "watched", add: true, watchedAt: "2026-11-12T10:00:00.000Z" },
      movie,
      synced,
      "/sync/watched",
      {
        movies: [
          {
            ids: { imdb: "tt0111161" },
            watched_at: "2026-11-12T10:00:00.000Z",
          },
        ],
      },
    ],
    [
      "rates the series, not the episode",
      { kind: "rating", rating: 9 },
      episode(2, 3),
      synced,
      "/sync/ratings",
      { shows: [{ ids: { imdb: "tt0903747" }, rating: 9 }] },
    ],
    [
      "removes a rating",
      { kind: "rating", rating: null },
      movie,
      synced,
      "/sync/ratings/remove",
      movieBody,
    ],
  ])("%s", async (_, intent, target, response, path, body) => {
    method = "POST";
    handler = () => Response.json(response);
    await actions.perform(connection(), intent, target);
    expect(calls[0].url.pathname).toBe(path);
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(bodyOf(calls[0])).toEqual(body);
  });

  it("fails when MDBList does not know the Title", async () => {
    method = "POST";
    handler = () =>
      Response.json({
        added: { movies: 0, shows: 0 },
        not_found: { movies: 1, shows: 0 },
      });
    await expect(
      actions.perform(connection(), { kind: "watchlist", add: true }, movie),
    ).rejects.toThrow(/does not know/);
  });

  it("marks the Catalog of the changed Source list as stale", () => {
    expect(actions.kinds).toEqual(["watchlist", "watched", "rating"]);
    expect(actions.affectedSources({ kind: "watchlist", add: true })).toEqual([
      "me/watchlist",
    ]);
    expect(actions.affectedSources({ kind: "watched", add: true })).toEqual([
      "me/history",
      "me/up-next",
    ]);
    expect(actions.affectedSources({ kind: "rating", rating: 5 })).toEqual([
      "me/ratings",
    ]);
  });

  it("reads membership from the watchlist, watched and ratings syncs", async () => {
    type SyncPage = Partial<
      Record<"movies" | "shows" | "seasons" | "episodes", unknown[]> & {
        pagination: { has_more: boolean; next_cursor?: string };
      }
    >;
    const sync = (page: SyncPage) =>
      Response.json({
        movies: [],
        shows: [],
        seasons: [],
        episodes: [],
        pagination: { has_more: false },
        ...page,
      });
    handler = (url) => {
      if (url.pathname === "/watchlist/items") {
        return itemsPage([BREAKING_BAD, NO_IMDB]);
      }
      if (url.pathname === "/sync/watched") {
        if (!url.searchParams.get("cursor")) {
          return sync({
            movies: [
              {
                last_watched_at: "2026-10-05T23:46:19.000Z",
                movie: { ids: { imdb: "tt0111161", tmdb: 278 } },
              },
            ],
            pagination: { has_more: true, next_cursor: "w2" },
          });
        }
        return sync({
          shows: [{ show: { ids: { imdb: "tt0903747", tmdb: 1396 } } }],
          episodes: [
            {
              episode: {
                season: 1,
                number: 1,
                ids: { tmdb: 62085 },
                show: { ids: { imdb: "tt0903747", tmdb: 1396 } },
              },
            },
          ],
        });
      }
      if (url.pathname === "/sync/ratings") {
        return sync({
          movies: [
            {
              rating: 8,
              rating_precise: 8,
              movie: { ids: { imdb: "tt0111161" } },
            },
          ],
          shows: [{ rating: 9, show: { ids: { imdb: "tt0903747" } } }],
        });
      }
      return noAnswer(url);
    };

    const membership = await actions.getMembership(connection());
    expect(membership).toEqual({
      watchlist: ["tt0903747"],
      watched: ["tt0111161", "tt0903747"],
      watchedEpisodes: ["tt0903747:1:1"],
      ratings: { tt0111161: 8, tt0903747: 9 },
    });
    const watchedCalls = calls.filter(
      (call) => call.url.pathname === "/sync/watched",
    );
    expect(watchedCalls).toHaveLength(2);
    expect(watchedCalls[1].url.searchParams.get("cursor")).toBe("w2");
    expect(watchedCalls[0].url.searchParams.get("limit")).toBe("1000");
  });
});

describe("listMdblistUserSources", () => {
  const ownList = {
    id: 42,
    name: "Favorites",
    slug: "favorites",
    items: 3,
    mediatype: "movie",
  };
  const externalList = {
    id: 77,
    name: "Letterboxd watchlist",
    source: "letterboxd",
    items: 10,
  };
  const likedList = {
    id: 14,
    user_id: 3,
    user_name: "linaspurinis",
    name: "Top Watched Movies of The Week / >60",
    slug: "top-watched-movies-of-the-week",
    mediatype: "movie",
    items: 50,
    likes: 900,
    private: false,
    dynamic: true,
    type: "dynamic",
    liked_at: "2026-11-01T10:00:00Z",
  };

  function likedPage(lists: unknown[], hasMore = false) {
    return Response.json({
      lists,
      pagination: {
        page: 1,
        limit: 100,
        offset: 0,
        total: lists.length,
        has_more: hasMore,
      },
    });
  }

  it("offers the user's own, external and liked lists, and recommendations", async () => {
    handler = (url) => {
      if (url.pathname === "/lists/user") return Response.json([ownList]);
      if (url.pathname === "/lists/recommended") {
        return Response.json({
          sections: [
            {
              slug: "because-watched",
              label: "Because You Watched",
              description: "",
              items_url: "/lists/recommended/because-watched/items",
            },
            {
              slug: "rising",
              label: "Rising Fast",
              description: "Accelerating in popularity right now",
              items_url: "/lists/recommended/rising/items",
            },
          ],
        });
      }
      if (url.pathname === "/lists/liked") {
        return url.searchParams.get("offset") === "0"
          ? likedPage([likedList], true)
          : likedPage([{ ...ownList, liked_at: "2026-10-01T10:00:00Z" }]);
      }
      return Response.json([externalList]);
    };
    await expect(listMdblistUserSources(connection())).resolves.toEqual([
      {
        ref: "me/lists/42",
        kind: "list",
        label: "Favorites",
        defaultDisplayMode: "movie",
      },
      {
        ref: "me/external/77",
        kind: "list",
        label: "Letterboxd watchlist",
        defaultDisplayMode: "split",
      },
      {
        ref: "lists/14",
        kind: "list",
        label: "Top Watched Movies of The Week / >60",
        defaultDisplayMode: "movie",
      },
      {
        ref: "recommended/because-watched",
        kind: "recommendations",
        label: "Because You Watched",
        defaultDisplayMode: "split",
      },
      {
        ref: "recommended/rising",
        kind: "recommendations",
        label: "Rising Fast",
        defaultDisplayMode: "split",
      },
    ]);
    const liked = calls.filter((call) => call.url.pathname === "/lists/liked");
    expect(
      liked.map((call) => Object.fromEntries(call.url.searchParams)),
    ).toEqual([
      { limit: "100", offset: "0" },
      { limit: "100", offset: "1" },
    ]);
  });

  it("still offers the other lists when liked lists and recommendations fail", async () => {
    vi.spyOn(console, "error");
    handler = (url) => {
      if (url.pathname === "/lists/user") return Response.json([ownList]);
      if (
        url.pathname === "/lists/liked" ||
        url.pathname === "/lists/recommended"
      ) {
        return Response.json({ error: "boom" }, { status: 500 });
      }
      return Response.json([externalList]);
    };
    const sources = await listMdblistUserSources(connection());
    expect(sources.map((source) => source.ref)).toEqual([
      "me/lists/42",
      "me/external/77",
    ]);
  });
});

describe("mdblistProvider.oauth", () => {
  const oauth = defined(mdblistProvider.oauth);

  it("uses the MDBList confidential web app endpoints", () => {
    vi.stubEnv("MDBLIST_CLIENT_ID", "client-id");
    vi.stubEnv("MDBLIST_CLIENT_SECRET", "client-secret");
    expect(oauth.authorizeUrl).toBe("https://mdblist.com/oauth/authorize/");
    expect(oauth.tokenUrl).toBe("https://api.mdblist.com/oauth/token/");
    expect(oauth.scopes).toEqual(["write"]);
    expect(oauth.clientId()).toBe("client-id");
    expect(oauth.clientSecret?.()).toBe("client-secret");
  });

  it("is not configured without a client ID", () => {
    vi.stubEnv("MDBLIST_CLIENT_ID", "");
    expect(oauth.clientId()).toBeUndefined();
  });

  it("reads the username from /user", async () => {
    handler = () =>
      Response.json({ user_id: 269425, username: "leo", auth_method: "oauth" });
    await expect(oauth.fetchUsername?.("token")).resolves.toBe("leo");
    expect(calls[0].url.toString()).toBe("https://api.mdblist.com/user");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe(
      "Bearer token",
    );
  });

  it("revokes the token with the client credentials", async () => {
    vi.stubEnv("MDBLIST_CLIENT_ID", "client-id");
    vi.stubEnv("MDBLIST_CLIENT_SECRET", "client-secret");
    method = "POST";
    handler = () => new Response("");
    await oauth.revoke?.("token");
    expect(calls[0].url.toString()).toBe(
      "https://api.mdblist.com/oauth/revoke_token/",
    );
    const body = new URLSearchParams(textBody(calls[0]));
    expect(Object.fromEntries(body)).toEqual({
      token: "token",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });
});
