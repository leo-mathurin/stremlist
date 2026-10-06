import { parseSourceLink } from "@stremlist/shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMdblistUserSources, mdblistProvider } from "../mdblist";
import type { ConnectionAccess } from "../types";
import { ConnectionExpiredError, SourceUnavailableError } from "../types";

// Shapes recorded from api.mdblist.com on 2026-10-06 (trimmed).
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

interface Call {
  url: URL;
  init: RequestInit;
}

let calls: Call[];
let handler: (url: URL, init: RequestInit) => Response;

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function connection(username: string | null = "leo"): ConnectionAccess {
  return {
    accountId: "sl_testaccount0000000000",
    provider: "mdblist",
    username,
    getAccessToken: () => Promise.resolve("user-token"),
  };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

function bodyOf(call: Call): unknown {
  return JSON.parse(call.init.body as string);
}

beforeEach(() => {
  calls = [];
  handler = () => json({ error: "unexpected" }, 500);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseSourceLink (MDBList)", () => {
  it("reads list links by owner and slug", () => {
    expect(
      parseSourceLink(
        "https://mdblist.com/lists/Linaspurinis/top-watched-movies-of-the-week/",
      ),
    ).toEqual({
      provider: "mdblist",
      ref: "lists/Linaspurinis/top-watched-movies-of-the-week",
      kind: "list",
      requiresConnection: true,
    });
  });

  it("reads watchlist links", () => {
    expect(parseSourceLink("mdblist.com/watchlist/leo")).toMatchObject({
      provider: "mdblist",
      ref: "watchlist/leo",
      kind: "watchlist",
      requiresConnection: true,
    });
  });

  it("ignores other MDBList pages", () => {
    expect(
      parseSourceLink(
        "https://mdblist.com/lists/official/movies/justwatch-streaming-charts",
      ),
    ).toBeNull();
    expect(
      parseSourceLink("https://mdblist.com/movie/2xwba-the-love-hypothesis"),
    ).toBeNull();
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
      json([
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
        ? json({ id: 77, name: "Letterboxd watchlist", mediatype: "movie" })
        : json({ id: 42, name: "Mixed", mediatype: null });
    await expect(
      mdblistProvider.validateSource("me/lists/42", {
        connection: connection(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      ref: "me/lists/42",
      defaultDisplayMode: "split",
    });
    await expect(
      mdblistProvider.validateSource("me/external/77", {
        connection: connection(),
      }),
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
    await expect(
      mdblistProvider.validateSource("watchlist/LEO", {
        connection: connection("leo"),
      }),
    ).resolves.toMatchObject({ ok: true, ref: "me/watchlist" });
    await expect(
      mdblistProvider.validateSource("watchlist/someone", {
        connection: connection("leo"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "private" });
    expect(calls).toHaveLength(0);
  });

  it("maps a missing list to not_found", async () => {
    handler = () => json({ error: "Not found" }, 404);
    await expect(
      mdblistProvider.validateSource("lists/leo/nope", {
        connection: connection(),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
  });

  it("rejects unknown refs", async () => {
    await expect(
      mdblistProvider.validateSource("users/leo", { connection: connection() }),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("mdblistProvider.fetchSource", () => {
  it("follows X-Next-Cursor and keeps the list order", async () => {
    handler = (url) => {
      if (!url.searchParams.get("cursor")) {
        return json([SUPER_MARIO, EPISODE_ITEM], 200, {
          "X-Has-More": "true",
          "X-Next-Cursor": "page-2",
        });
      }
      return json([NO_IMDB, BREAKING_BAD], 200, { "X-Has-More": "false" });
    };
    const snapshot = await mdblistProvider.fetchSource("lists/14", {
      connection: connection(),
    });

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
        externalIds: { tmdb: { id: 502356, type: "movie" }, tvdb: 136578 },
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
        externalIds: { tmdb: { id: 1396, type: "series" }, tvdb: 81189 },
        title: "Breaking Bad",
        year: 2008,
      },
    ]);
  });

  it("stops when the cursor repeats", async () => {
    handler = () =>
      json([SUPER_MARIO], 200, {
        "X-Has-More": "true",
        "X-Next-Cursor": "same",
      });
    const snapshot = await mdblistProvider.fetchSource("lists/14", {
      connection: connection(),
    });
    expect(calls).toHaveLength(2);
    // Items may be missing after a loop: not a complete synchronization.
    expect(snapshot.complete).toBe(false);
  });

  it("marks a list cut by the page cap as incomplete", async () => {
    let page = 0;
    handler = () =>
      json([SUPER_MARIO], 200, {
        "X-Has-More": "true",
        "X-Next-Cursor": `page-${++page}`,
      });
    const snapshot = await mdblistProvider.fetchSource("lists/14", {
      connection: connection(),
    });
    expect(calls).toHaveLength(50);
    expect(snapshot.complete).toBe(false);
  });

  it("reads the watchlist oldest added first", async () => {
    // MDBList returns the watchlist newest first.
    handler = () =>
      json([BREAKING_BAD, SHAWSHANK], 200, { "X-Has-More": "false" });
    const snapshot = await mdblistProvider.fetchSource("me/watchlist", {
      connection: connection(),
    });
    expect(calls[0].url.pathname).toBe("/watchlist/items");
    expect(snapshot.entries.map((entry) => entry.imdbId)).toEqual([
      "tt0111161",
      "tt0903747",
    ]);
  });

  it("reads lists by slug, own lists and external lists", async () => {
    handler = () => json([], 200, { "X-Has-More": "false" });
    const ctx = { connection: connection() };
    await mdblistProvider.fetchSource("lists/leo/my-list", ctx);
    await mdblistProvider.fetchSource("me/lists/42", ctx);
    await mdblistProvider.fetchSource("me/external/77", ctx);
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
    handler = () => json(body, status);
    const error = await mdblistProvider
      .fetchSource("lists/14", { connection: connection() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect((error as SourceUnavailableError).reason).toBe(reason);
  });

  it("maps an expired Connection to needs_connection", async () => {
    const expired = new ConnectionExpiredError("mdblist");
    const access: ConnectionAccess = {
      accountId: "sl_testaccount0000000000",
      provider: "mdblist",
      username: "leo",
      getAccessToken: () => Promise.reject(expired),
    };
    await expect(
      mdblistProvider.fetchSource("me/watchlist", { connection: access }),
    ).rejects.toMatchObject({ reason: "needs_connection" });
    expect(calls).toHaveLength(0);
  });

  it("does not treat server errors as an expected state", async () => {
    handler = () => json({ error: "boom" }, 502);
    const error = await mdblistProvider
      .fetchSource("lists/14", { connection: connection() })
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("needs a Connection", async () => {
    await expect(
      mdblistProvider.fetchSource("me/watchlist", { connection: null }),
    ).rejects.toMatchObject({ reason: "needs_connection" });
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
  const ok = () =>
    json({ updated: { movies: 1 }, not_found: { movies: [], shows: [] } });

  it("adds a movie to the watchlist", async () => {
    handler = () =>
      json({
        added: { movies: 1, shows: 0 },
        not_found: { movies: 0, shows: 0 },
      });
    await actions.perform(
      connection(),
      { kind: "watchlist", add: true },
      { imdbId: "tt0111161", type: "movie" },
    );
    expect(calls[0].url.pathname).toBe("/watchlist/items/add");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(bodyOf(calls[0])).toEqual({
      movies: [{ ids: { imdb: "tt0111161" } }],
    });
  });

  it("removes the series, not the episode, from the watchlist", async () => {
    handler = () =>
      json({
        removed: { movies: 0, shows: 0 },
        not_found: { movies: 0, shows: 1 },
      });
    await actions.perform(
      connection(),
      { kind: "watchlist", add: false },
      {
        imdbId: "tt0903747",
        type: "series",
        episode: { season: 1, episode: 2 },
      },
    );
    expect(calls[0].url.pathname).toBe("/watchlist/items/remove");
    expect(bodyOf(calls[0])).toEqual({
      shows: [{ ids: { imdb: "tt0903747" } }],
    });
  });

  it("fails when MDBList does not know the Title", async () => {
    handler = () =>
      json({
        added: { movies: 0, shows: 0 },
        not_found: { movies: 1, shows: 0 },
      });
    await expect(
      actions.perform(
        connection(),
        { kind: "watchlist", add: true },
        { imdbId: "tt0000001", type: "movie" },
      ),
    ).rejects.toThrow(/does not know/);
  });

  it("marks one episode as watched and unwatched", async () => {
    handler = ok;
    const target = {
      imdbId: "tt0903747",
      type: "series" as const,
      episode: { season: 1, episode: 1 },
    };
    await actions.perform(connection(), { kind: "watched", add: true }, target);
    await actions.perform(
      connection(),
      { kind: "watched", add: false },
      target,
    );
    const episodeBody = {
      shows: [
        {
          ids: { imdb: "tt0903747" },
          seasons: [{ number: 1, episodes: [{ number: 1 }] }],
        },
      ],
    };
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/sync/watched",
      "/sync/watched/remove",
    ]);
    expect(bodyOf(calls[0])).toEqual(episodeBody);
    expect(bodyOf(calls[1])).toEqual(episodeBody);
  });

  it("marks a whole movie as watched", async () => {
    handler = ok;
    await actions.perform(
      connection(),
      { kind: "watched", add: true },
      { imdbId: "tt0111161", type: "movie" },
    );
    expect(bodyOf(calls[0])).toEqual({
      movies: [{ ids: { imdb: "tt0111161" } }],
    });
  });

  it("rates a series and removes a rating", async () => {
    handler = ok;
    await actions.perform(
      connection(),
      { kind: "rating", rating: 9 },
      {
        imdbId: "tt0903747",
        type: "series",
        episode: { season: 2, episode: 3 },
      },
    );
    await actions.perform(
      connection(),
      { kind: "rating", rating: null },
      { imdbId: "tt0111161", type: "movie" },
    );
    expect(calls[0].url.pathname).toBe("/sync/ratings");
    expect(bodyOf(calls[0])).toEqual({
      shows: [{ ids: { imdb: "tt0903747" }, rating: 9 }],
    });
    expect(calls[1].url.pathname).toBe("/sync/ratings/remove");
    expect(bodyOf(calls[1])).toEqual({
      movies: [{ ids: { imdb: "tt0111161" } }],
    });
  });

  it("rejects ratings outside 1 to 10", async () => {
    await expect(
      actions.perform(
        connection(),
        { kind: "rating", rating: 11 },
        { imdbId: "tt0111161", type: "movie" },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("marks only the watchlist Catalog as stale", () => {
    expect(actions.kinds).toEqual(["watchlist", "watched", "rating"]);
    expect(actions.affectedSources({ kind: "watchlist", add: true })).toEqual([
      "me/watchlist",
    ]);
    expect(actions.affectedSources({ kind: "watched", add: true })).toEqual([]);
    expect(actions.affectedSources({ kind: "rating", rating: 5 })).toEqual([]);
  });

  it("reads membership from the watchlist, watched and ratings syncs", async () => {
    handler = (url) => {
      if (url.pathname === "/watchlist/items") {
        return json([BREAKING_BAD, NO_IMDB], 200, { "X-Has-More": "false" });
      }
      if (url.pathname === "/sync/watched") {
        if (!url.searchParams.get("cursor")) {
          return json({
            movies: [
              {
                last_watched_at: "2026-10-05T23:46:19.000Z",
                movie: { ids: { imdb: "tt0111161", tmdb: 278 } },
              },
            ],
            shows: [],
            seasons: [],
            episodes: [],
            pagination: { has_more: true, next_cursor: "w2" },
          });
        }
        return json({
          movies: [],
          shows: [{ show: { ids: { imdb: "tt0903747", tmdb: 1396 } } }],
          seasons: [],
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
          pagination: { has_more: false },
        });
      }
      if (url.pathname === "/sync/ratings") {
        return json({
          movies: [
            {
              rating: 8,
              rating_precise: 8,
              movie: { ids: { imdb: "tt0111161" } },
            },
          ],
          shows: [{ rating: 9, show: { ids: { imdb: "tt0903747" } } }],
          seasons: [],
          episodes: [],
          pagination: { has_more: false },
        });
      }
      return json({ error: "unexpected" }, 500);
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
  it("offers the user's own lists and external lists", async () => {
    handler = (url) =>
      url.pathname === "/lists/user"
        ? json([
            {
              id: 42,
              name: "Favorites",
              slug: "favorites",
              items: 3,
              mediatype: "movie",
            },
          ])
        : json([
            {
              id: 77,
              name: "Letterboxd watchlist",
              source: "letterboxd",
              items: 10,
            },
          ]);
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
      json({ user_id: 269425, username: "leo", auth_method: "oauth" });
    await expect(oauth.fetchUsername?.("token")).resolves.toBe("leo");
    expect(calls[0].url.toString()).toBe("https://api.mdblist.com/user");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe(
      "Bearer token",
    );
  });

  it("revokes the token with the client credentials", async () => {
    vi.stubEnv("MDBLIST_CLIENT_ID", "client-id");
    vi.stubEnv("MDBLIST_CLIENT_SECRET", "client-secret");
    handler = () => new Response("", { status: 200 });
    await oauth.revoke?.("token");
    expect(calls[0].url.toString()).toBe(
      "https://api.mdblist.com/oauth/revoke_token/",
    );
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      token: "token",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });
});
