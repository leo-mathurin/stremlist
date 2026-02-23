import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getImdbWatchlist,
  fetchWatchlist,
  validateImdbWatchlist,
} from "../imdb-scraper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(overrides: {
  id?: string;
  title?: string;
  type?: string;
  year?: number;
  rating?: number;
  genres?: string[];
  runtimeSeconds?: number;
  directors?: string[];
  cast?: string[];
}) {
  const {
    id = "tt0000001",
    title = "Test Movie",
    type = "Movie",
    year = 2020,
    rating = 7.5,
    genres = ["Drama"],
    runtimeSeconds = 5400,
    directors = ["Some Director"],
    cast = ["Actor One", "Actor Two"],
  } = overrides;

  return {
    listItem: {
      id,
      titleText: { text: title },
      titleType: { text: type },
      releaseYear: { year },
      ratingsSummary: { aggregateRating: rating },
      titleGenres: { genres: genres.map((g) => ({ genre: { text: g } })) },
      plot: { plotText: { plainText: "A test plot." } },
      primaryImage: { url: "https://example.com/poster.jpg" },
      runtime: { seconds: runtimeSeconds },
      principalCredits: [
        {
          category: { id: "director" },
          credits: directors.map((name) => ({
            name: { nameText: { text: name } },
          })),
        },
        {
          category: { id: "cast" },
          credits: cast.map((name) => ({
            name: { nameText: { text: name } },
          })),
        },
      ],
    },
  };
}

function mockGraphQLResponse(
  predefinedList: object | null,
  ok = true,
  status = 200,
) {
  const body = JSON.stringify({
    data: { predefinedList },
    extensions: {},
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
    ...(ok ? {} : { statusText: "Bad Request" }),
  });
}

// ---------------------------------------------------------------------------
// Unit tests — fetch is mocked
// ---------------------------------------------------------------------------

describe("getImdbWatchlist (unit)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns edges for a public watchlist", async () => {
    const edge = makeEdge({ id: "tt0068646", title: "The Godfather" });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123456",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 1, edges: [edge] },
      }),
    );

    const result = await getImdbWatchlist("ur195879360");

    expect(result).toHaveLength(1);
    expect(result[0].listItem.id).toBe("tt0068646");
    expect(result[0].listItem.titleText?.text).toBe("The Godfather");
  });

  it("throws for a nonexistent user (predefinedList: null)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse(null),
    );

    await expect(getImdbWatchlist("ur999999999")).rejects.toThrow(
      /Could not find an IMDb watchlist/,
    );
  });

  it("throws for a private watchlist", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls999999",
        visibility: { id: "PRIVATE" },
        titleListItemSearch: { total: 0, edges: [] },
      }),
    );

    await expect(getImdbWatchlist("ur198342247")).rejects.toThrow(/private/i);
  });

  it("throws when GraphQL returns errors", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ errors: [{ message: "Some GraphQL error" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(getImdbWatchlist("ur1198342247")).rejects.toThrow(
      /Could not find an IMDb watchlist/,
    );
  });

  it("throws private error when GraphQL returns FORBIDDEN", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { predefinedList: null },
          errors: [
            {
              message: "Forbidden",
              extensions: { code: "FORBIDDEN" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(getImdbWatchlist("ur198342247")).rejects.toThrow(/private/i);
  });

  it("throws when HTTP response is not ok", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    await expect(getImdbWatchlist("ur999999999")).rejects.toThrow(
      /Could not find an IMDb watchlist/,
    );
  });

  it("returns an empty array when the watchlist has no edges", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 0, edges: [] },
      }),
    );

    const result = await getImdbWatchlist("ur195879360");
    expect(result).toEqual([]);
  });

  it("sends the correct request to the IMDb GraphQL endpoint", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 1, edges: [makeEdge({})] },
      }),
    );

    await getImdbWatchlist("ur195879360");

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toBe("https://api.graphql.imdb.com/");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-imdb-client-name"]).toBe("imdb-next-desktop");

    const body = JSON.parse(init.body as string) as {
      operationName: string;
      variables: { urConst: string };
    };
    expect(body.operationName).toBe("WatchListPage");
    expect(body.variables.urConst).toBe("ur195879360");
  });
});

// ---------------------------------------------------------------------------
// Unit tests — validateImdbWatchlist with mocked fetch
// ---------------------------------------------------------------------------

describe("validateImdbWatchlist (unit)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns valid for a public watchlist", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123456",
        visibility: { id: "PUBLIC" },
      }),
    );

    const result = await validateImdbWatchlist("ur195879360");
    expect(result).toEqual({ valid: true });
  });

  it("returns private for a FORBIDDEN error", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { predefinedList: null },
          errors: [
            {
              message: "Forbidden",
              extensions: { code: "FORBIDDEN" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await validateImdbWatchlist("ur198342247");
    expect(result).toEqual({ valid: false, reason: "private" });
  });

  it("returns not_found for a nonexistent user", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse(null),
    );

    const result = await validateImdbWatchlist("ur999999999");
    expect(result).toEqual({ valid: false, reason: "not_found" });
  });

  it("returns not_found when fetch throws", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(
      new Error("Network error"),
    );

    const result = await validateImdbWatchlist("ur999999999");
    expect(result).toEqual({ valid: false, reason: "not_found" });
  });

  it("returns private for a PRIVATE visibility", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls999999",
        visibility: { id: "PRIVATE" },
      }),
    );

    const result = await validateImdbWatchlist("ur198342247");
    expect(result).toEqual({ valid: false, reason: "private" });
  });
});

// ---------------------------------------------------------------------------
// Unit tests — fetchWatchlist with mocked fetch
// ---------------------------------------------------------------------------

describe("fetchWatchlist (unit)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns metas for a public watchlist", async () => {
    const edges = [
      makeEdge({
        id: "tt0068646",
        title: "The Godfather",
        type: "Movie",
        year: 1972,
        rating: 9.2,
      }),
      makeEdge({
        id: "tt2560140",
        title: "Attack on Titan",
        type: "TV Series",
        year: 2013,
        rating: 9.1,
      }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 2, edges },
      }),
    );

    const result = await fetchWatchlist("ur195879360");

    expect(result.metas).toHaveLength(2);
    const godfather = result.metas.find((m) => m.id === "tt0068646");
    expect(godfather).toBeDefined();
    expect(godfather?.name).toBe("The Godfather");
    expect(godfather?.type).toBe("movie");
    expect(godfather?.imdbRating).toBe("9.2");
    expect(godfather?.releaseInfo).toBe("1972");
    expect(godfather?.runtime).toBe("1h 30m");
    expect(godfather?.poster).toBe("https://example.com/poster.jpg");

    const aot = result.metas.find((m) => m.id === "tt2560140");
    expect(aot?.type).toBe("series");
  });

  it("uses RPDB poster URLs when an RPDB API key is provided", async () => {
    const edges = [makeEdge({ id: "tt0068646", title: "The Godfather" })];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 1, edges },
      }),
    );

    const result = await fetchWatchlist(
      "ur195879360",
      { by: "added_at", order: "asc" },
      "my-rpdb-key",
    );

    expect(result.metas).toHaveLength(1);
    expect(result.metas[0].poster).toBe(
      "https://api.ratingposterdb.com/my-rpdb-key/imdb/poster-default/tt0068646.jpg?fallback=true",
    );
  });

  it("filters out non-movie/series types (e.g. TV Episode)", async () => {
    const edges = [
      makeEdge({ id: "tt0000001", type: "Movie" }),
      makeEdge({ id: "tt0000002", type: "TV Episode" }),
      makeEdge({ id: "tt0000003", type: "Video Game" }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 3, edges },
      }),
    );

    const result = await fetchWatchlist("ur195879360");

    expect(result.metas).toHaveLength(1);
    expect(result.metas[0].id).toBe("tt0000001");
  });

  it("sorts by title ascending", async () => {
    const edges = [
      makeEdge({ id: "tt0000003", title: "Zulu" }),
      makeEdge({ id: "tt0000001", title: "Alpha" }),
      makeEdge({ id: "tt0000002", title: "Mango" }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 3, edges },
      }),
    );

    const result = await fetchWatchlist("ur195879360", {
      by: "title",
      order: "asc",
    });

    expect(result.metas.map((m) => m.name)).toEqual(["Alpha", "Mango", "Zulu"]);
  });

  it("sorts by rating descending", async () => {
    const edges = [
      makeEdge({ id: "tt0000001", title: "Low", rating: 5.0 }),
      makeEdge({ id: "tt0000002", title: "High", rating: 9.5 }),
      makeEdge({ id: "tt0000003", title: "Mid", rating: 7.0 }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 3, edges },
      }),
    );

    const result = await fetchWatchlist("ur195879360", {
      by: "rating",
      order: "desc",
    });

    expect(result.metas.map((m) => m.imdbRating)).toEqual(["9.5", "7", "5"]);
  });

  it("sorts by year ascending", async () => {
    const edges = [
      makeEdge({ id: "tt0000001", title: "New", year: 2020 }),
      makeEdge({ id: "tt0000002", title: "Old", year: 1990 }),
      makeEdge({ id: "tt0000003", title: "Mid", year: 2005 }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 3, edges },
      }),
    );

    const result = await fetchWatchlist("ur195879360", {
      by: "year",
      order: "asc",
    });

    expect(result.metas.map((m) => m.releaseInfo)).toEqual([
      "1990",
      "2005",
      "2020",
    ]);
  });

  it("throws when all items are filtered out", async () => {
    const edges = [makeEdge({ id: "tt0000001", type: "TV Episode" })];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockGraphQLResponse({
        id: "ls123",
        visibility: { id: "PUBLIC" },
        titleListItemSearch: { total: 1, edges },
      }),
    );

    await expect(fetchWatchlist("ur195879360")).rejects.toThrow(
      /empty or may not contain/,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real network calls to IMDb GraphQL API
// ---------------------------------------------------------------------------

describe("integration: real IMDb GraphQL API", () => {
  it("fetches a public watchlist (ur195879360)", async () => {
    const result = await fetchWatchlist("ur195879360");

    expect(result.metas.length).toBeGreaterThan(0);
    for (const meta of result.metas) {
      expect(meta.id).toMatch(/^tt\d+$/);
      expect(meta.type).toMatch(/^(movie|series)$/);
      expect(meta.name).toBeTruthy();
    }
  });

  it("fetches a second public watchlist (ur100660343)", async () => {
    const result = await fetchWatchlist("ur100660343");

    expect(result.metas.length).toBeGreaterThan(0);
    for (const meta of result.metas) {
      expect(meta.id).toMatch(/^tt\d+$/);
    }
  });

  // The unauthenticated GraphQL API returns a FORBIDDEN error for private
  // lists, allowing us to distinguish them from nonexistent users.
  it("throws for a private watchlist (ur198342247)", async () => {
    await expect(fetchWatchlist("ur198342247")).rejects.toThrow(/private/i);
  });

  it("throws for an invalid IMDb user ID (ur1198342247)", async () => {
    await expect(fetchWatchlist("ur1198342247")).rejects.toThrow(
      /Could not find an IMDb watchlist/,
    );
  });

  it("throws for an empty watchlist (ur198654279)", async () => {
    await expect(fetchWatchlist("ur198654279")).rejects.toThrow(
      /empty or may not contain/,
    );
  });
});
