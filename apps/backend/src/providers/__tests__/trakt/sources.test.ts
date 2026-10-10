import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traktProvider } from "../../trakt";
import {
  clerks,
  halloween,
  listed,
  mandalorian,
  noImdbShow,
  pitt,
} from "./fixtures";
import {
  calls,
  callsTo,
  clearCalls,
  connection,
  fetchEntries,
  json,
  pages,
  resetTraktTest,
  restoreTraktTest,
  route,
  status,
} from "./harness";

vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetTraktTest);
afterEach(restoreTraktTest);

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

    const { entries, complete } = await traktProvider.fetchSource(
      "users/sean/watchlist",
      { connection: null },
    );

    expect(complete).toBe(true);
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
    const snapshot = await traktProvider.fetchSource("users/big/watchlist", {
      connection: null,
    });
    expect(snapshot.entries).toHaveLength(5000);
    expect(snapshot.complete).toBe(false);
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

    clearCalls();
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
    // Merged Lists sort Source lists together by these dates.
    expect(entries.map((e) => e.addedAt)).toEqual([
      "2021-01-01T00:00:00.000Z",
      "2022-10-14T03:19:22.000Z",
      "2024-05-01T00:00:00.000Z",
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
        addedAt: "2022-01-01T00:00:00.000Z",
      },
      {
        imdbId: "tt8111088",
        type: "series",
        title: "The Mandalorian",
        year: 2019,
        externalIds: { tmdb: { id: 82856, type: "series" }, trakt: 137178 },
        addedAt: "2022-01-02T00:00:00.000Z",
      },
      {
        type: "series",
        title: "New Anime",
        year: 2026,
        externalIds: { tmdb: { id: 777001, type: "series" }, trakt: 999001 },
        addedAt: "2022-01-04T00:00:00.000Z",
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
