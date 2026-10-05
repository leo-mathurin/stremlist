import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as HttpModule from "../http";
import { traktProvider } from "../trakt";
import type {
  ConnectionAccess,
  OAuthConfig,
  ProviderActions,
  SourceEntry,
} from "../types";
import { SourceUnavailableError } from "../types";

// The real limiters would make this file wait (1 write per second, a burst
// cap on public reads); their behavior is not under test here.
vi.mock("../http", async (importOriginal) => {
  const original = await importOriginal<typeof HttpModule>();
  class NoWaitLimiter {
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...original, RateLimiter: NoWaitLimiter };
});

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response;

let routes: { match: string; handler: Handler }[] = [];
let calls: Call[] = [];

/** Route on "METHOD /path" (query ignored). Later routes win. */
function route(match: string, handler: Handler | Response | object): void {
  const fn: Handler =
    typeof handler === "function"
      ? (handler as Handler)
      : handler instanceof Response
        ? () => handler.clone()
        : () => json(handler);
  routes.unshift({ match, handler: fn });
}

function json(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function status(code: number): Response {
  return new Response(code === 204 ? null : "", { status: code });
}

/** One page of a paginated endpoint, chosen by the `page` query parameter. */
function pages(all: unknown[][]): Handler {
  return (call) => {
    const page = Number(call.url.searchParams.get("page") ?? "1");
    return json(all[page - 1] ?? [], {
      headers: {
        "X-Pagination-Page": String(page),
        "X-Pagination-Page-Count": String(all.length),
      },
    });
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing Trakt adapter part");
  return value;
}

function callsTo(path: string): Call[] {
  return calls.filter((call) => call.url.pathname === path);
}

beforeEach(() => {
  routes = [];
  calls = [];
  vi.stubEnv("TRAKT_CLIENT_ID", "client-123");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const call: Call = {
        method,
        url,
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const found = routes.find(
        ({ match }) => match === `${method} ${url.pathname}`,
      );
      if (!found) {
        return Promise.reject(new Error(`Unexpected ${method} ${url.href}`));
      }
      return Promise.resolve(found.handler(call));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function connection(tokens: string[] = ["token-1"]): ConnectionAccess & {
  getAccessToken: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  return {
    provider: "trakt",
    username: "leo",
    getAccessToken: vi.fn(() =>
      Promise.resolve(tokens[Math.min(index++, tokens.length - 1)]),
    ),
  };
}

// Recorded shapes (api.trakt.tv, 2026-10-06), trimmed.
const clerks = {
  title: "Clerks III",
  year: 2022,
  ids: {
    trakt: 475091,
    slug: "clerks-iii-2022",
    imdb: "tt11128440",
    tmdb: 635891,
  },
};
const halloween = {
  title: "Halloween Ends",
  year: 2022,
  ids: {
    trakt: 460030,
    slug: "halloween-ends-2022",
    imdb: "tt10665342",
    tmdb: 616820,
  },
};
const mandalorian = {
  title: "The Mandalorian",
  year: 2019,
  ids: {
    trakt: 137178,
    slug: "the-mandalorian",
    imdb: "tt8111088",
    tmdb: 82856,
    tvdb: 361753,
  },
};
const pitt = {
  title: "The Pitt",
  year: 2025,
  ids: {
    trakt: 232884,
    slug: "the-pitt",
    imdb: "tt31938062",
    tmdb: 250307,
    tvdb: 448176,
  },
};
const noImdbShow = {
  title: "New Anime",
  year: 2026,
  ids: {
    trakt: 999001,
    slug: "new-anime",
    imdb: null,
    tmdb: 777001,
    tvdb: null,
  },
};

function listed(
  type: "movie" | "show" | "season" | "episode",
  media: object,
  listedAt: string,
  rank: number,
): object {
  const base = { rank, id: rank * 10, listed_at: listedAt, notes: null, type };
  if (type === "movie") return { ...base, movie: media };
  if (type === "show") return { ...base, show: media };
  if (type === "season")
    return { ...base, show: media, season: { number: 1, ids: { trakt: 1 } } };
  return {
    ...base,
    show: media,
    episode: { season: 1, number: 2, ids: { trakt: 2 } },
  };
}

async function fetchEntries(
  ref: string,
  conn: ConnectionAccess | null = null,
): Promise<SourceEntry[]> {
  return (await traktProvider.fetchSource(ref, { connection: conn })).entries;
}

async function expectReason(promise: Promise<unknown>, reason: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SourceUnavailableError);
  expect((error as SourceUnavailableError).reason).toBe(reason);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("Trakt reads", () => {
  it("follows every page with the largest page size", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) =>
      listed(
        "movie",
        {
          title: `M${i}`,
          year: 2000,
          ids: { trakt: i + 1, imdb: `tt${1000000 + i}` },
        },
        `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        i,
      ),
    );
    route(
      "GET /users/sean/watchlist",
      pages([
        page1,
        [listed("movie", clerks, "2022-10-14T03:19:22.000Z", 251)],
      ]),
    );

    const entries = await fetchEntries("users/sean/watchlist");

    const requests = callsTo("/users/sean/watchlist");
    expect(requests).toHaveLength(2);
    expect(requests.map((c) => c.url.searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
    expect(
      requests.every((c) => c.url.searchParams.get("limit") === "250"),
    ).toBe(true);
    expect(entries).toHaveLength(251);
    expect(entries.at(-1)?.imdbId).toBe("tt11128440");
  });

  it("stops when the endpoint sends no pagination headers", async () => {
    route("GET /users/sean/watchlist", [
      listed("movie", clerks, "2022-10-14T03:19:22.000Z", 1),
    ]);
    await fetchEntries("users/sean/watchlist");
    expect(callsTo("/users/sean/watchlist")).toHaveLength(1);
  });

  it("caps a huge Source list", async () => {
    const page = Array.from({ length: 250 }, (_, i) =>
      listed(
        "movie",
        { title: "x", ids: { trakt: i, imdb: `tt${2000000 + i}` } },
        "2020-01-01T00:00:00.000Z",
        i,
      ),
    );
    route("GET /users/big/watchlist", (call) =>
      json(
        page.map((item, i) => ({
          ...item,
          movie: {
            title: "x",
            ids: {
              trakt: Number(call.url.searchParams.get("page")) * 1000 + i,
              imdb: `tt${Number(call.url.searchParams.get("page")) * 1000 + i + 3000000}`,
            },
          },
        })),
        { headers: { "X-Pagination-Page-Count": "100" } },
      ),
    );
    const entries = await fetchEntries("users/big/watchlist");
    expect(entries).toHaveLength(5000);
    expect(callsTo("/users/big/watchlist")).toHaveLength(20);
  });

  it("sends the client ID without a Connection, and the token with one", async () => {
    route("GET /users/sean/watchlist", []);
    await fetchEntries("users/sean/watchlist");
    const [publicCall] = calls;
    expect(publicCall.headers.get("trakt-api-key")).toBe("client-123");
    expect(publicCall.headers.get("trakt-api-version")).toBe("2");
    expect(publicCall.headers.get("User-Agent")).toMatch(/^Stremlist\//);
    expect(publicCall.headers.has("Authorization")).toBe(false);

    calls = [];
    await fetchEntries("users/sean/watchlist", connection());
    expect(calls[0].headers.get("Authorization")).toBe("Bearer token-1");
    expect(calls[0].headers.get("trakt-api-key")).toBe("client-123");
  });

  it("puts entries in canonical order, oldest added first", async () => {
    route("GET /users/sean/lists/mandoverse/items", [
      listed("movie", halloween, "2024-05-01T00:00:00.000Z", 1),
      listed("show", mandalorian, "2021-01-01T00:00:00.000Z", 2),
      listed("movie", clerks, "2022-10-14T03:19:22.000Z", 3),
    ]);
    const entries = await fetchEntries("users/sean/lists/mandoverse");
    expect(entries.map((e) => e.imdbId)).toEqual([
      "tt8111088",
      "tt11128440",
      "tt10665342",
    ]);
    const query = callsTo("/users/sean/lists/mandoverse/items")[0].url
      .searchParams;
    expect(query.get("sort_by")).toBe("added");
    expect(query.get("sort_how")).toBe("asc");
  });

  it("maps entries, seasons and episodes to their show, and keeps entries without IMDb ID", async () => {
    route("GET /lists/2142753/items", [
      listed("movie", clerks, "2022-01-01T00:00:00.000Z", 1),
      listed("season", mandalorian, "2022-01-02T00:00:00.000Z", 2),
      listed("episode", mandalorian, "2022-01-03T00:00:00.000Z", 3),
      listed("show", noImdbShow, "2022-01-04T00:00:00.000Z", 4),
      {
        rank: 5,
        id: 50,
        listed_at: "2022-01-05T00:00:00.000Z",
        type: "person",
        person: { name: "Someone" },
      },
    ]);
    const entries = await fetchEntries("lists/2142753");
    expect(entries).toEqual([
      {
        imdbId: "tt11128440",
        type: "movie",
        title: "Clerks III",
        year: 2022,
        externalIds: { tmdb: { id: 635891, type: "movie" }, trakt: 475091 },
      },
      {
        imdbId: "tt8111088",
        type: "series",
        title: "The Mandalorian",
        year: 2019,
        externalIds: {
          tmdb: { id: 82856, type: "series" },
          trakt: 137178,
          tvdb: 361753,
        },
      },
      {
        type: "series",
        title: "New Anime",
        year: 2026,
        externalIds: { tmdb: { id: 777001, type: "series" }, trakt: 999001 },
      },
    ]);
  });

  it("reads charts for movies and shows, in rank order", async () => {
    route("GET /movies/trending", [
      { watchers: 1246, movie: clerks },
      { watchers: 824, movie: halloween },
    ]);
    route("GET /shows/trending", [{ watchers: 900, show: pitt }]);
    const entries = await fetchEntries("trending");
    expect(entries.map((e) => [e.type, e.imdbId])).toEqual([
      ["movie", "tt11128440"],
      ["series", "tt31938062"],
      ["movie", "tt10665342"],
    ]);
    expect(callsTo("/movies/trending")[0].url.searchParams.get("limit")).toBe(
      "100",
    );
  });

  it("reads popular rows, which are the media itself", async () => {
    route("GET /movies/popular", [clerks]);
    route("GET /shows/popular", [pitt]);
    const entries = await fetchEntries("popular");
    expect(entries.map((e) => e.imdbId)).toEqual(["tt11128440", "tt31938062"]);
  });

  it("reads anticipated rows", async () => {
    route("GET /movies/anticipated", [{ list_count: 73252, movie: halloween }]);
    route("GET /shows/anticipated", []);
    expect((await fetchEntries("anticipated")).map((e) => e.imdbId)).toEqual([
      "tt10665342",
    ]);
  });

  it("reads me/watchlist and me/lists through the Connection", async () => {
    route("GET /users/me/watchlist", [
      listed("movie", clerks, "2022-10-14T03:19:22.000Z", 1),
    ]);
    route("GET /users/me/lists/favs/items", [
      listed("show", pitt, "2025-01-01T00:00:00.000Z", 1),
    ]);
    const conn = connection();
    expect(
      (await fetchEntries("me/watchlist", conn)).map((e) => e.imdbId),
    ).toEqual(["tt11128440"]);
    expect(
      (await fetchEntries("me/lists/favs", conn)).map((e) => e.imdbId),
    ).toEqual(["tt31938062"]);
  });

  it("reads up next as shows, oldest watched first", async () => {
    route(
      "GET /sync/progress/up_next",
      pages([
        [
          {
            show: pitt,
            progress: {
              aired: 30,
              completed: 3,
              last_watched_at: "2026-09-01T00:00:00.000Z",
              next_episode: { season: 1, number: 4 },
            },
          },
          {
            show: mandalorian,
            progress: {
              aired: 24,
              completed: 10,
              last_watched_at: "2024-01-01T00:00:00.000Z",
              next_episode: { season: 2, number: 3 },
            },
          },
        ],
      ]),
    );
    const entries = await fetchEntries("me/up-next", connection());
    expect(entries.map((e) => [e.type, e.imdbId])).toEqual([
      ["series", "tt8111088"],
      ["series", "tt31938062"],
    ]);
  });

  it("falls back to watched progress when up next is not available to the app", async () => {
    route("GET /sync/progress/up_next", status(403));
    route("GET /sync/progress/watched", (call) => {
      expect(call.url.searchParams.get("hide_completed")).toBe("true");
      return json([
        {
          show: pitt,
          progress: { last_watched_at: "2026-09-01T00:00:00.000Z" },
        },
      ]);
    });
    expect(
      (await fetchEntries("me/up-next", connection())).map((e) => e.imdbId),
    ).toEqual(["tt31938062"]);
  });

  it("reads history from watched movies and shows, by last watch", async () => {
    route("GET /users/me/watched/movies", [
      { plays: 1, last_watched_at: "2025-03-01T00:00:00.000Z", movie: clerks },
    ]);
    route("GET /users/me/watched/shows", (call) => {
      expect(call.url.searchParams.get("extended")).toBe("noseasons");
      return json([
        {
          plays: 3,
          last_watched_at: "2024-03-01T00:00:00.000Z",
          show: mandalorian,
        },
        { plays: 1, last_watched_at: "2026-03-01T00:00:00.000Z", show: pitt },
      ]);
    });
    const entries = await fetchEntries("me/history", connection());
    expect(entries.map((e) => e.imdbId)).toEqual([
      "tt8111088",
      "tt11128440",
      "tt31938062",
    ]);
  });

  it("reads the collection, by collection date", async () => {
    route(
      "GET /sync/collection/movies",
      pages([
        [
          {
            collected_at: "2023-01-01T00:00:00.000Z",
            updated_at: "2023-01-01T00:00:00.000Z",
            type: "movie",
            movie: halloween,
          },
        ],
      ]),
    );
    route("GET /sync/collection/shows", [
      {
        last_collected_at: "2020-01-01T00:00:00.000Z",
        type: "show",
        show: mandalorian,
        seasons: [],
      },
    ]);
    const entries = await fetchEntries("me/collection", connection());
    expect(entries.map((e) => e.imdbId)).toEqual(["tt8111088", "tt10665342"]);
  });

  it("reads recommendations for movies and shows", async () => {
    route("GET /recommendations/movies", [
      { ...clerks, favorited_by: [], recommended_by: [] },
    ]);
    route("GET /recommendations/shows", [
      { ...pitt, favorited_by: [], recommended_by: [] },
    ]);
    const entries = await fetchEntries("me/recommendations", connection());
    expect(entries.map((e) => [e.type, e.imdbId])).toEqual([
      ["movie", "tt11128440"],
      ["series", "tt31938062"],
    ]);
  });
});

describe("Trakt read errors", () => {
  it("a 401 on a public read means the Source list is private", async () => {
    route("GET /users/hidden/watchlist", status(401));
    await expectReason(fetchEntries("users/hidden/watchlist"), "private");
  });

  it("maps 404 to not_found", async () => {
    route("GET /users/sean/lists/gone/items", status(404));
    await expectReason(fetchEntries("users/sean/lists/gone"), "not_found");
  });

  it.each([420, 426])("maps %i to premium_only", async (code) => {
    route("GET /lists/42/items", status(code));
    await expectReason(fetchEntries("lists/42"), "premium_only");
  });

  it("other errors stay server errors", async () => {
    route("GET /lists/42/items", status(502));
    const error = await fetchEntries("lists/42").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("personal Source lists need a Connection", async () => {
    await expectReason(fetchEntries("me/watchlist"), "needs_connection");
    await expectReason(fetchEntries("me/up-next"), "needs_connection");
    expect(calls).toHaveLength(0);
  });

  it("retries a 401 once when the Connection gives a new token", async () => {
    route("GET /users/me/watchlist", (call) =>
      call.headers.get("Authorization") === "Bearer token-2"
        ? json([])
        : status(401),
    );
    const conn = connection(["token-1", "token-2"]);
    await expect(fetchEntries("me/watchlist", conn)).resolves.toEqual([]);
    expect(conn.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("a token that keeps being refused means needs_connection", async () => {
    route("GET /users/me/watchlist", status(401));
    await expectReason(
      fetchEntries("me/watchlist", connection()),
      "needs_connection",
    );
  });

  it("an expired Connection means needs_connection", async () => {
    const conn = connection();
    conn.getAccessToken.mockRejectedValue(
      Object.assign(new Error("expired"), { name: "ConnectionExpiredError" }),
    );
    await expectReason(fetchEntries("me/history", conn), "needs_connection");
  });

  it("a public Source list read with a refused token tries without it", async () => {
    route("GET /users/sean/watchlist", (call) =>
      call.headers.has("Authorization")
        ? status(401)
        : json([listed("movie", clerks, "2022-10-14T03:19:22.000Z", 1)]),
    );
    const entries = await fetchEntries("users/sean/watchlist", connection());
    expect(entries.map((e) => e.imdbId)).toEqual(["tt11128440"]);
  });

  it("a private user stays private with a Connection", async () => {
    route("GET /users/hidden/watchlist", status(401));
    await expectReason(
      fetchEntries("users/hidden/watchlist", connection()),
      "private",
    );
  });

  it("an unknown ref is not_found", async () => {
    await expectReason(fetchEntries("users/x/favorites"), "not_found");
  });
});

// ---------------------------------------------------------------------------
// Validation, resolution, freshness
// ---------------------------------------------------------------------------

describe("Trakt validateSource", () => {
  it("accepts charts without a network call", async () => {
    await expect(
      traktProvider.validateSource("trending", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "trending",
      suggestedTitle: "Trakt Trending",
      defaultDisplayMode: "split",
    });
    expect(calls).toHaveLength(0);
  });

  it("checks that a user exists before accepting a watchlist", async () => {
    route("GET /users/ghost", status(404));
    route("GET /users/ghost/watchlist", []);
    await expect(
      traktProvider.validateSource("users/ghost/watchlist", {
        connection: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("names a public watchlist after its user", async () => {
    route("GET /users/sean", {
      username: "Sean",
      private: false,
      ids: { slug: "sean" },
    });
    route("GET /users/sean/watchlist", []);
    await expect(
      traktProvider.validateSource("users/sean/watchlist", {
        connection: null,
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "users/sean/watchlist",
      suggestedTitle: "Sean's watchlist",
      defaultDisplayMode: "split",
    });
  });

  it("reports a private watchlist", async () => {
    route("GET /users/hidden", status(401));
    await expect(
      traktProvider.validateSource("users/hidden/watchlist", {
        connection: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "private",
    });
  });

  it("treats Trakt's 204 for a missing list as not_found", async () => {
    route("GET /users/sean/lists/nope", status(204));
    await expect(
      traktProvider.validateSource("users/sean/lists/nope", {
        connection: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("uses the list name and stores shared lists by numeric ID", async () => {
    route("GET /lists/imdb-top-rated-movies", {
      name: "IMDB: Top Rated Movies",
      ids: { slug: "imdb-top-rated-movies", trakt: 2142753 },
    });
    await expect(
      traktProvider.validateSource("lists/imdb-top-rated-movies", {
        connection: null,
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "lists/2142753",
      suggestedTitle: "IMDB: Top Rated Movies",
      defaultDisplayMode: "split",
    });
  });

  it("personal Source lists need a Connection, and up next shows series", async () => {
    await expect(
      traktProvider.validateSource("me/up-next", { connection: null }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "needs_connection",
    });
    route("GET /users/settings", { user: { username: "leo" } });
    await expect(
      traktProvider.validateSource("me/up-next", { connection: connection() }),
    ).resolves.toEqual({
      ok: true,
      ref: "me/up-next",
      suggestedTitle: "Trakt Up Next",
      defaultDisplayMode: "series",
    });
  });

  it("rejects refs it does not know", async () => {
    await expect(
      traktProvider.validateSource("users/sean", { connection: null }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("Trakt resolution and freshness", () => {
  it("keys entries without IMDb ID by Trakt ID and type", () => {
    expect(
      traktProvider.resolutionKey?.({
        type: "series",
        externalIds: { trakt: 999001 },
      }),
    ).toEqual({
      namespace: "trakt-show",
      externalId: "999001",
    });
    expect(
      traktProvider.resolutionKey?.({
        type: "movie",
        externalIds: { trakt: 5 },
      }),
    ).toEqual({
      namespace: "trakt-movie",
      externalId: "5",
    });
    expect(traktProvider.resolutionKey?.({ type: "movie" })).toBeNull();
    expect(traktProvider.resolverStrategies?.map((s) => s.name)).toEqual([
      "tmdb-external-ids",
    ]);
  });

  it("keeps public Source lists fresh longer than personal ones", () => {
    const freshness = (ref: string) => traktProvider.freshnessFor?.(ref);
    expect(freshness("trending")).toBe(6 * 60 * 60_000);
    expect(freshness("users/sean/watchlist")).toBe(6 * 60 * 60_000);
    expect(freshness("lists/42")).toBe(6 * 60 * 60_000);
    expect(freshness("me/watchlist")).toBe(30 * 60_000);
    expect(freshness("me/up-next")).toBe(30 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe("Trakt actions", () => {
  const actions: ProviderActions = required(traktProvider.actions);

  it("reads membership: watchlist, watched episodes and ratings", async () => {
    route(
      "GET /users/me/watchlist",
      pages([
        [
          listed("movie", clerks, "2022-01-01T00:00:00.000Z", 1),
          listed("show", pitt, "2022-01-01T00:00:00.000Z", 2),
          listed("episode", mandalorian, "2022-01-01T00:00:00.000Z", 3),
        ],
      ]),
    );
    route("GET /sync/watched/movies", [
      {
        plays: 2,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        movie: halloween,
      },
    ]);
    route("GET /sync/watched/shows", [
      {
        plays: 3,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        show: mandalorian,
        seasons: [
          {
            number: 1,
            episodes: [
              { number: 1, plays: 1 },
              { number: 2, plays: 2 },
            ],
          },
          { number: 2, episodes: [{ number: 1, plays: 1 }] },
        ],
      },
      {
        plays: 0,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        show: pitt,
        seasons: [],
      },
      {
        plays: 1,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        show: noImdbShow,
        seasons: [{ number: 1, episodes: [{ number: 1 }] }],
      },
    ]);
    route("GET /sync/ratings/movies", [
      {
        rated_at: "2024-01-01T00:00:00.000Z",
        rating: 8,
        type: "movie",
        movie: clerks,
      },
    ]);
    route("GET /sync/ratings/shows", [
      {
        rated_at: "2024-01-01T00:00:00.000Z",
        rating: 10,
        type: "show",
        show: mandalorian,
      },
    ]);

    const membership = await actions.getMembership(connection());

    expect(membership).toEqual({
      watchlist: ["tt11128440", "tt31938062"],
      watched: ["tt10665342", "tt8111088"],
      watchedEpisodes: ["tt8111088:1:1", "tt8111088:1:2", "tt8111088:2:1"],
      ratings: { tt11128440: 8, tt8111088: 10 },
    });
    expect(
      calls.every((c) => c.headers.get("Authorization") === "Bearer token-1"),
    ).toBe(true);
  });

  async function performed(
    intent: Parameters<typeof actions.perform>[1],
    target: Parameters<typeof actions.perform>[2],
  ): Promise<Call> {
    route(`POST /sync/watchlist`, {
      added: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/watchlist/remove`, {
      deleted: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/history`, {
      added: {},
      not_found: { movies: [], shows: [], episodes: [] },
    });
    route(`POST /sync/history/remove`, {
      deleted: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/ratings`, {
      added: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/ratings/remove`, {
      deleted: {},
      not_found: { movies: [], shows: [] },
    });
    calls = [];
    await actions.perform(connection(), intent, target);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer token-1");
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    return calls[0];
  }

  it("adds and removes watchlist entries by IMDb ID", async () => {
    const add = await performed(
      { kind: "watchlist", add: true },
      { imdbId: "tt11128440", type: "movie" },
    );
    expect(add.url.pathname).toBe("/sync/watchlist");
    expect(add.body).toEqual({ movies: [{ ids: { imdb: "tt11128440" } }] });

    const remove = await performed(
      { kind: "watchlist", add: false },
      { imdbId: "tt8111088", type: "series" },
    );
    expect(remove.url.pathname).toBe("/sync/watchlist/remove");
    expect(remove.body).toEqual({ shows: [{ ids: { imdb: "tt8111088" } }] });
  });

  it("marks a movie, a show and one episode as watched or unwatched", async () => {
    const movie = await performed(
      { kind: "watched", add: true },
      { imdbId: "tt11128440", type: "movie" },
    );
    expect(movie.url.pathname).toBe("/sync/history");
    expect(movie.body).toEqual({ movies: [{ ids: { imdb: "tt11128440" } }] });

    const show = await performed(
      { kind: "watched", add: true },
      { imdbId: "tt8111088", type: "series" },
    );
    expect(show.body).toEqual({ shows: [{ ids: { imdb: "tt8111088" } }] });

    const episode = await performed(
      { kind: "watched", add: false },
      {
        imdbId: "tt8111088",
        type: "series",
        episode: { season: 2, episode: 5 },
      },
    );
    expect(episode.url.pathname).toBe("/sync/history/remove");
    expect(episode.body).toEqual({
      shows: [
        {
          ids: { imdb: "tt8111088" },
          seasons: [{ number: 2, episodes: [{ number: 5 }] }],
        },
      ],
    });
  });

  it("rates and removes a rating", async () => {
    const rate = await performed(
      { kind: "rating", rating: 7 },
      { imdbId: "tt8111088", type: "series" },
    );
    expect(rate.url.pathname).toBe("/sync/ratings");
    expect(rate.body).toEqual({
      shows: [{ ids: { imdb: "tt8111088" }, rating: 7 }],
    });

    const clear = await performed(
      { kind: "rating", rating: null },
      { imdbId: "tt11128440", type: "movie" },
    );
    expect(clear.url.pathname).toBe("/sync/ratings/remove");
    expect(clear.body).toEqual({ movies: [{ ids: { imdb: "tt11128440" } }] });
  });

  it("rejects ratings outside 1 to 10", async () => {
    await expect(
      actions.perform(
        connection(),
        { kind: "rating", rating: 11 },
        { imdbId: "tt1", type: "movie" },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("fails when Trakt does not know the Title", async () => {
    route("POST /sync/watchlist", {
      added: { movies: 0 },
      not_found: { movies: [{ ids: { imdb: "tt0000001" } }] },
    });
    await expect(
      actions.perform(
        connection(),
        { kind: "watchlist", add: true },
        { imdbId: "tt0000001", type: "movie" },
      ),
    ).rejects.toThrow(/does not know/);
  });

  it("fails on account limits and VIP-only writes", async () => {
    route("POST /sync/watchlist", status(420));
    await expect(
      actions.perform(
        connection(),
        { kind: "watchlist", add: true },
        { imdbId: "tt11128440", type: "movie" },
      ),
    ).rejects.toThrow(/account limit/);
  });

  it("names the Source lists that each Action changes", () => {
    expect(actions.kinds).toEqual(["watchlist", "watched", "rating"]);
    expect(actions.affectedSources({ kind: "watchlist", add: true })).toEqual([
      "me/watchlist",
    ]);
    expect(actions.affectedSources({ kind: "watched", add: false })).toEqual([
      "me/history",
      "me/up-next",
    ]);
    expect(actions.affectedSources({ kind: "rating", rating: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

describe("Trakt OAuth", () => {
  const oauth: OAuthConfig = required(traktProvider.oauth);

  it("uses the auth host and a public PKCE client", () => {
    expect(oauth.authorizeUrl).toBe("https://auth.trakt.tv/oauth/authorize");
    expect(oauth.tokenUrl).toBe("https://auth.trakt.tv/oauth/token");
    expect(oauth.clientId()).toBe("client-123");
    expect(oauth.clientSecret?.()).toBeUndefined();
    vi.stubEnv("TRAKT_CLIENT_SECRET", "secret-456");
    expect(oauth.clientSecret?.()).toBe("secret-456");
    vi.stubEnv("TRAKT_CLIENT_ID", "");
    expect(oauth.clientId()).toBeUndefined();
  });

  it("revokes a token on the auth host", async () => {
    route("POST /oauth/revoke", json({}));
    await oauth.revoke?.("token-9");
    expect(calls[0].url.host).toBe("auth.trakt.tv");
    expect(calls[0].body).toEqual({
      token: "token-9",
      client_id: "client-123",
    });
  });

  it("reads the username from the user settings", async () => {
    route("GET /users/settings", {
      user: { username: "Leo", ids: { slug: "leo" } },
      limits: {},
    });
    await expect(oauth.fetchUsername?.("token-9")).resolves.toBe("Leo");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer token-9");
    expect(calls[0].headers.get("trakt-api-key")).toBe("client-123");
  });
});
