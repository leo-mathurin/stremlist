import { http, HttpResponse } from "msw";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vite-plus/test";
import {
  getImdbList,
  getImdbRatings,
  getImdbWatchlist,
  fetchWatchlist,
  normalizeImdbUserId,
  validateImdbWatchlist,
} from "../imdb-scraper.js";
import { z } from "zod";
import { useMswServer } from "../../test/helpers/msw.test-utils";

const GRAPHQL_ENDPOINT = "https://api.graphql.imdb.com/";
const PROFILE_PAGE = "https://www.imdb.com/user/:handle/";

const pageRequest = z.object({
  variables: z.object({ first: z.number() }),
});

const watchlistRequest = z.object({
  variables: z.object({ urConst: z.string() }),
});

const server = useMswServer();
const requests: string[] = [];
server.events.on("request:start", ({ request }) => {
  requests.push(request.url);
});

beforeEach(() => {
  requests.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEdge(
  overrides: {
    id?: string;
    title?: string;
    type?: string;
    year?: number;
    rating?: number;
  } = {},
) {
  const {
    id = "tt0000001",
    title = "Test Movie",
    type = "Movie",
    year = 2020,
    rating = 7.5,
  } = overrides;

  return {
    listItem: {
      id,
      titleText: { text: title },
      titleType: { text: type },
      releaseYear: { year },
      ratingsSummary: { aggregateRating: rating },
      titleGenres: { genres: [{ genre: { text: "Drama" } }] },
      plot: { plotText: { plainText: "A test plot." } },
      primaryImage: { url: "https://example.com/poster.jpg" },
      runtime: { seconds: 5400 },
      principalCredits: [
        {
          category: { id: "director" },
          credits: [{ name: { nameText: { text: "Some Director" } } }],
        },
        {
          category: { id: "cast" },
          credits: ["Actor One", "Actor Two"].map((name) => ({
            name: { nameText: { text: name } },
          })),
        },
      ],
    },
  };
}

function jsonResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function respond(response: Response) {
  server.use(http.post(GRAPHQL_ENDPOINT, () => response, { once: true }));
}

function respondProfile(response: Response) {
  server.use(http.get(PROFILE_PAGE, () => response, { once: true }));
}

function recordProfileRequests(userId: string) {
  const sent: Request[] = [];
  server.use(
    http.get(PROFILE_PAGE, ({ request }) => {
      sent.push(request);
      return profileHtml(userId);
    }),
  );
  return sent;
}

function watchlistResponse(predefinedList: Record<string, unknown> | null) {
  return jsonResponse({ data: { predefinedList }, extensions: {} });
}

function publicWatchlist(edges: object[] = []) {
  return watchlistResponse({
    id: "ls123",
    visibility: { id: "PUBLIC" },
    titleListItemSearch: { total: edges.length, edges },
  });
}

const PRIVATE_WATCHLIST = () =>
  watchlistResponse({
    id: "ls999999",
    visibility: { id: "PRIVATE" },
    titleListItemSearch: { total: 0, edges: [] },
  });

const FORBIDDEN = () =>
  jsonResponse({
    data: { predefinedList: null },
    errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }],
  });

const NOT_FOUND = () => new Response("Not Found", { status: 404 });

function profileHtml(userId: string) {
  return new Response(
    `<html><head><script>window.__NEXT_DATA__ = {"userId":"${userId}","profileId":"p.something"};</script></head></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}

function servePages(
  total: number,
  pageOf: (titleListItemSearch: Record<string, unknown>) => Response = (
    search,
  ) =>
    watchlistResponse({
      id: "ls123",
      visibility: { id: "PUBLIC" },
      titleListItemSearch: search,
    }),
  hasNextPage = (offset: number) => offset < total,
) {
  const requestedPageSizes: number[] = [];
  let offset = 0;
  server.use(
    http.post(GRAPHQL_ENDPOINT, async ({ request }) => {
      const requested = pageRequest.parse(await request.json()).variables.first;
      requestedPageSizes.push(requested);
      const edges = Array.from({ length: requested }, (_, index) =>
        makeEdge({ id: `tt${String(offset + index).padStart(7, "0")}` }),
      );
      offset += requested;
      return pageOf({
        total,
        edges,
        pageInfo: {
          hasNextPage: hasNextPage(offset),
          endCursor: `item-${offset}`,
        },
      });
    }),
  );
  return requestedPageSizes;
}

const NOT_FOUND_ERROR = /Could not find an IMDb watchlist/;

describe("getImdbWatchlist (unit)", () => {
  it("returns edges for a public watchlist", async () => {
    respond(
      publicWatchlist([makeEdge({ id: "tt0068646", title: "The Godfather" })]),
    );

    const { items: result } = await getImdbWatchlist("ur195879360");

    expect(result).toHaveLength(1);
    expect(result[0].listItem.id).toBe("tt0068646");
    expect(result[0].listItem.titleText?.text).toBe("The Godfather");
  });

  it.each([
    [
      "a nonexistent user (predefinedList: null)",
      () => watchlistResponse(null),
      NOT_FOUND_ERROR,
    ],
    ["a private watchlist", PRIVATE_WATCHLIST, /private/i],
    [
      "GraphQL errors",
      () => jsonResponse({ errors: [{ message: "Some GraphQL error" }] }),
      NOT_FOUND_ERROR,
    ],
    ["a FORBIDDEN GraphQL error", FORBIDDEN, /private/i],
    [
      "a non-ok HTTP response",
      () => new Response("Forbidden", { status: 403 }),
      NOT_FOUND_ERROR,
    ],
  ])("throws for %s", async (_case, response, error) => {
    respond(response());

    await expect(getImdbWatchlist("ur198342247")).rejects.toThrow(error);
  });

  it("returns an empty array when the watchlist has no edges", async () => {
    respond(publicWatchlist());

    const { items: result } = await getImdbWatchlist("ur195879360");
    expect(result).toEqual([]);
  });

  it("supports 15,000 items without crossing a cursor window", async () => {
    const warn = vi.spyOn(console, "warn");
    const requestedPageSizes = servePages(15_001, undefined, () => true);

    const { items: result, complete } = await getImdbWatchlist("ur195879360");

    expect(result).toHaveLength(15_000);
    expect(complete).toBe(false);
    expect(requestedPageSizes).toEqual([
      ...Array<number>(13).fill(750),
      250,
      ...Array<number>(6).fill(750),
      500,
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("15,000-item limit"),
    );
  });

  it("reduces the final page size to avoid crossing IMDb's cursor boundary", async () => {
    const requestedPageSizes = servePages(1_000);

    const { items: result } = await getImdbWatchlist("ur195879360");

    expect(result).toHaveLength(1_000);
    expect(requestedPageSizes).toEqual([750, 250]);
  });

  it("sends the correct request to the IMDb GraphQL endpoint", async () => {
    const sent: Request[] = [];
    server.use(
      http.post(GRAPHQL_ENDPOINT, ({ request }) => {
        sent.push(request);
        return publicWatchlist([makeEdge()]);
      }),
    );

    await getImdbWatchlist("ur195879360");

    const [request] = sent;
    expect(request.url).toBe("https://api.graphql.imdb.com/");
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(request.headers)).toMatchObject({
      "content-type": "application/json",
      "x-imdb-client-name": "imdb-next-desktop",
    });
    expect(await request.json()).toMatchObject({
      operationName: "WatchListPage",
      variables: { urConst: "ur195879360" },
    });
  });
});

describe("getImdbList (unit)", () => {
  it("starts a new page at the 10,000-item cursor boundary", async () => {
    const requestedPageSizes = servePages(10_001, (titleListItemSearch) =>
      jsonResponse({
        data: {
          list: {
            id: "ls123456789",
            visibility: { id: "PUBLIC" },
            titleListItemSearch,
          },
        },
        extensions: {},
      }),
    );

    const { items: result } = await getImdbList("ls123456789");

    expect(result).toHaveLength(10_001);
    expect(requestedPageSizes).toEqual([
      ...Array<number>(13).fill(750),
      250,
      1,
    ]);
  });
});

describe("getImdbRatings (unit)", () => {
  it("keeps the newest 10,000 ratings, where IMDb's search ends", async () => {
    const warn = vi.spyOn(console, "warn");
    const requestedPageSizes = servePages(17_282, ({ edges, ...search }) =>
      jsonResponse({
        data: {
          advancedTitleSearch: {
            ...search,
            edges: z
              .array(z.object({ listItem: z.object({}).loose() }))
              .parse(edges)
              .map(({ listItem }) => ({
                node: {
                  title: {
                    ...listItem,
                    userRating: { date: "2026-01-01T00:00:00.000Z" },
                  },
                },
              })),
          },
        },
      }),
    );

    const { items, complete } = await getImdbRatings("ur1000000");

    expect(items).toHaveLength(10_000);
    expect(complete).toBe(false);
    expect(requestedPageSizes).toEqual([...Array<number>(13).fill(750), 250]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("10,000-item limit"),
    );
  });
});

describe("validateImdbWatchlist (unit)", () => {
  it("returns valid for a public watchlist", async () => {
    respond(publicWatchlist());

    await expect(validateImdbWatchlist("ur195879360")).resolves.toEqual({
      valid: true,
      userId: "ur195879360",
    });
  });

  it.each([
    ["private", "a FORBIDDEN error", FORBIDDEN],
    ["private", "a PRIVATE visibility", PRIVATE_WATCHLIST],
    ["not_found", "a nonexistent user", () => watchlistResponse(null)],
  ])("returns %s for %s", async (reason, _case, response) => {
    respond(response());

    await expect(validateImdbWatchlist("ur198342247")).resolves.toEqual({
      valid: false,
      reason,
    });
  });

  it("returns not_found when fetch throws", async () => {
    server.use(
      http.post(GRAPHQL_ENDPOINT, () => HttpResponse.error(), { once: true }),
    );

    await expect(validateImdbWatchlist("ur999999999")).resolves.toEqual({
      valid: false,
      reason: "not_found",
    });
  });

  it("resolves p.handle and returns canonical userId on success", async () => {
    respondProfile(profileHtml("ur205394592"));
    respond(publicWatchlist());

    await expect(
      validateImdbWatchlist("p.3pi7ewljpbf27th5h7d3cz6rjm"),
    ).resolves.toEqual({ valid: true, userId: "ur205394592" });
  });

  it("returns not_found when p.handle resolution fails", async () => {
    respondProfile(NOT_FOUND());

    await expect(
      validateImdbWatchlist("p.nonexistent-handle-xyz"),
    ).resolves.toEqual({ valid: false, reason: "not_found" });
  });
});

describe("fetchWatchlist (unit)", () => {
  it("keeps complete release dates without inventing partial or invalid dates", async () => {
    const dates = [
      { year: 2000, month: 2, day: 29 },
      { year: 2000 },
      { year: 2001, month: 2, day: 29 },
    ];
    respond(
      publicWatchlist(
        dates.map((releaseDate, index) => {
          const edge = makeEdge({ id: `tt000000${index}` });
          return { listItem: { ...edge.listItem, releaseDate } };
        }),
      ),
    );
    const { metas, complete } = await fetchWatchlist("ur195879360");
    expect(complete).toBe(true);
    expect(metas.map((meta) => meta.released)).toEqual([
      "2000-02-29T00:00:00.000Z",
      undefined,
      undefined,
    ]);
  });

  it("returns metas for a public watchlist", async () => {
    respond(
      publicWatchlist([
        makeEdge({
          id: "tt0068646",
          title: "The Godfather",
          year: 1972,
          rating: 9.2,
        }),
        makeEdge({ id: "tt2560140", type: "TV Series" }),
      ]),
    );

    const { metas } = await fetchWatchlist("ur195879360");

    expect(metas).toHaveLength(2);
    expect(metas.find((m) => m.id === "tt0068646")).toMatchObject({
      name: "The Godfather",
      type: "movie",
      imdbRating: "9.2",
      releaseInfo: "1972",
      runtime: "1h 30m",
      poster: "https://example.com/poster.jpg",
    });
    expect(metas.find((m) => m.id === "tt2560140")?.type).toBe("series");
  });

  it.each([
    [
      "filters out non-movie/series types (e.g. TV Episode)",
      ["Movie", "TV Episode", "Video Game"],
      ["movie"],
    ],
    [
      "maps single-video IMDb subtypes (TV Movie, Short, Video, etc.) to type 'movie'",
      ["Movie", "TV Movie", "TV Special", "Short", "TV Short", "Video"],
      Array<string>(6).fill("movie"),
    ],
    [
      "maps TV Series and TV Mini Series to type 'series'",
      ["TV Series", "TV Mini Series"],
      ["series", "series"],
    ],
    ["returns empty metas when all items are filtered out", ["TV Episode"], []],
  ])("%s", async (_case, types, expected) => {
    respond(
      publicWatchlist(
        types.map((type, index) => makeEdge({ id: `tt100000${index}`, type })),
      ),
    );

    const { metas } = await fetchWatchlist("ur195879360");

    expect(metas.map((meta) => meta.type)).toEqual(expected);
    if (expected.length === 1) expect(metas[0].id).toBe("tt1000000");
  });

  it("preserves IMDb list order and original posters", async () => {
    const edges = [
      makeEdge({ id: "tt0000003", title: "Zulu" }),
      makeEdge({ id: "tt0000001", title: "Alpha" }),
    ];
    respond(publicWatchlist(edges));
    const { metas } = await fetchWatchlist("ur195879360");
    expect(metas.map((meta) => meta.name)).toEqual(["Zulu", "Alpha"]);
    expect(metas[0].poster).toBe(edges[0].listItem.primaryImage.url);
  });
});

describe("normalizeImdbUserId (unit)", () => {
  it("short-circuits canonical ur... IDs without any fetch", async () => {
    expect(await normalizeImdbUserId("ur195879360")).toBe("ur195879360");
    expect(requests).toEqual([]);
  });

  it("resolves a p.handle to its canonical ur id using the FB UA", async () => {
    const sent = recordProfileRequests("ur1000000");

    expect(await normalizeImdbUserId("p.colneedham")).toBe("ur1000000");

    const [request] = sent;
    expect(request.url).toBe("https://www.imdb.com/user/p.colneedham/");
    expect(request.headers.get("User-Agent")).toBe("facebookexternalhit/1.1");
  });

  it("resolves the p.handle of a ratings reference and keeps the suffix", async () => {
    const sent = recordProfileRequests("ur1000000");

    expect(await normalizeImdbUserId("p.ratingshandle/ratings")).toBe(
      "ur1000000/ratings",
    );
    expect(sent.map((request) => request.url)).toEqual([
      "https://www.imdb.com/user/p.ratingshandle/",
    ]);
  });

  it("caches resolved p.handle results (second call does not re-fetch)", async () => {
    respondProfile(profileHtml("ur132907031"));

    expect(await normalizeImdbUserId("p.dfxwro2juo3hexdmee2gezdxi4")).toBe(
      "ur132907031",
    );
    expect(await normalizeImdbUserId("p.dfxwro2juo3hexdmee2gezdxi4")).toBe(
      "ur132907031",
    );
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["the profile page is non-200", "p.does-not-exist-xyz", NOT_FOUND],
    [
      "the HTML has no userId match",
      "p.unparsable-handle",
      () =>
        new Response("<html><body>nothing here</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
  ])("throws ERROR_NOT_FOUND when %s", async (_case, handle, response) => {
    respondProfile(response());

    await expect(normalizeImdbUserId(handle)).rejects.toThrow(NOT_FOUND_ERROR);
  });
});

describe("integration: IMDb GraphQL API", () => {
  beforeEach(() => {
    server.use(
      http.post(GRAPHQL_ENDPOINT, async ({ request }) => {
        const { urConst } = watchlistRequest.parse(
          await request.json(),
        ).variables;
        switch (urConst) {
          case "ur195879360":
          case "ur100660343":
            return publicWatchlist([
              makeEdge({ id: "tt0068646", title: "The Godfather" }),
              makeEdge({
                id: "tt0903747",
                title: "Breaking Bad",
                type: "TV Series",
              }),
            ]);
          case "ur198342247":
            return PRIVATE_WATCHLIST();
          case "ur198654279":
            return publicWatchlist();
          default:
            return watchlistResponse(null);
        }
      }),
    );
  });

  it.each(["ur195879360", "ur100660343"])(
    "fetches a public watchlist (%s)",
    async (userId) => {
      const { metas } = await fetchWatchlist(userId);

      expect(metas.length).toBeGreaterThan(0);
      for (const meta of metas) {
        expect(meta.id).toMatch(/^tt\d+$/);
        expect(meta.type).toMatch(/^(movie|series)$/);
        expect(meta.name).toBeTruthy();
      }
    },
  );

  it("throws for a private watchlist (ur198342247)", async () => {
    await expect(fetchWatchlist("ur198342247")).rejects.toThrow(/private/i);
  });

  it("throws for an invalid IMDb user ID (ur1198342247)", async () => {
    await expect(fetchWatchlist("ur1198342247")).rejects.toThrow(
      NOT_FOUND_ERROR,
    );
  });

  it("returns empty metas for an empty watchlist (ur198654279)", async () => {
    expect((await fetchWatchlist("ur198654279")).metas).toEqual([]);
  });
});
