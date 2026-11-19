import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { traktProvider } from "../../trakt";
import {
  clerks,
  halloween,
  listed,
  mandalorian,
  noImdbShow,
  pitt,
} from "./trakt.fixture";
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
  unavailableReason,
} from "./harness";
import { onFakeClock } from "../../../test/helpers/clock.test-utils";

const server = useMswServer();

const clerksShow = {
  title: "Clerks: The Animated Series",
  year: 2000,
  ids: { trakt: 1915, imdb: "tt0206512" },
};

beforeEach(() => resetTraktTest(server));
afterEach(restoreTraktTest);

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
    const snapshot = await onFakeClock(() =>
      traktProvider.fetchSource("users/big/watchlist", {
        connection: null,
      }),
    );
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

  it("reads the weekly charts and the movie-only box office", async () => {
    route("GET /movies/watched/weekly", [
      { watcher_count: 17589, play_count: 18309, movie: clerks },
    ]);
    route("GET /shows/watched/weekly", [
      { watcher_count: 42568, play_count: 98171, show: pitt },
    ]);
    expect(
      (await fetchEntries("watched")).map((e) => [e.type, e.imdbId]),
    ).toEqual([
      ["movie", "tt11128440"],
      ["series", "tt31938062"],
    ]);
    route("GET /movies/boxoffice", [
      { revenue: 19000000, movie: halloween },
      { revenue: 11400000, movie: clerks },
    ]);
    expect((await fetchEntries("boxoffice")).map((e) => e.imdbId)).toEqual([
      "tt10665342",
      "tt11128440",
    ]);
    expect(callsTo("/shows/boxoffice")).toHaveLength(0);
  });

  it("reads a public user's favorites, oldest added first", async () => {
    route(
      "GET /users/sean/favorites",
      pages([
        [
          {
            ...listed("show", pitt, "2024-02-01T00:00:00.000Z", 2),
            notes: null,
          },
          {
            ...listed("movie", clerks, "2020-08-01T04:47:04.000Z", 20),
            notes: null,
          },
        ],
      ]),
    );
    const { entries, complete } = await traktProvider.fetchSource(
      "users/sean/favorites",
      { connection: null },
    );
    expect(entries.map((e) => [e.imdbId, e.addedAt])).toEqual([
      ["tt11128440", "2020-08-01T04:47:04.000Z"],
      ["tt31938062", "2024-02-01T00:00:00.000Z"],
    ]);
    expect(complete).toBe(true);
    expect(calls[0].headers.has("Authorization")).toBe(false);
  });

  it("reads rated movies and shows by rating date, without episodes", async () => {
    route(
      "GET /users/sean/ratings/movies",
      pages([
        [
          {
            rated_at: "2022-07-12T19:28:14.000Z",
            rating: 10,
            type: "movie",
            movie: clerks,
          },
        ],
      ]),
    );
    route(
      "GET /users/sean/ratings/shows",
      pages([
        [
          {
            rated_at: "2021-01-01T00:00:00.000Z",
            rating: 9,
            type: "show",
            show: pitt,
          },
        ],
      ]),
    );
    const entries = await fetchEntries("users/sean/ratings");
    expect(entries.map((e) => [e.imdbId, e.addedAt])).toEqual([
      ["tt31938062", "2021-01-01T00:00:00.000Z"],
      ["tt11128440", "2022-07-12T19:28:14.000Z"],
    ]);
    expect(callsTo("/users/sean/ratings")).toHaveLength(0);
  });

  it("reads the user's own favorites and ratings through the Connection", async () => {
    route("GET /users/me/favorites", [
      listed("movie", clerks, "2022-10-14T03:19:22.000Z", 1),
    ]);
    route("GET /users/me/ratings/movies", [
      { rated_at: "2022-01-01T00:00:00.000Z", rating: 8, movie: halloween },
    ]);
    route("GET /users/me/ratings/shows", []);
    for (const ref of ["me/favorites", "me/ratings"]) {
      await expect(fetchEntries(ref)).rejects.toMatchObject({
        reason: "needs_connection",
      });
    }
    expect(
      (await fetchEntries("me/favorites", connection())).map((e) => e.imdbId),
    ).toEqual(["tt11128440"]);
    expect(
      (await fetchEntries("me/ratings", connection())).map((e) => e.imdbId),
    ).toEqual(["tt10665342"]);
    expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("reads a public user's history and collection without a Connection", async () => {
    route("GET /users/sean/watched/movies", [
      { plays: 1, last_watched_at: "2025-03-01T00:00:00.000Z", movie: clerks },
    ]);
    route("GET /users/sean/watched/shows", [
      { plays: 2, last_watched_at: "2024-03-01T00:00:00.000Z", show: pitt },
    ]);
    expect(
      (await fetchEntries("users/sean/history")).map((e) => e.imdbId),
    ).toEqual(["tt31938062", "tt11128440"]);
    route(
      "GET /users/sean/collection/movies",
      pages([
        [
          {
            collected_at: "2026-11-10T02:20:23.000Z",
            type: "movie",
            movie: halloween,
          },
        ],
      ]),
    );
    route("GET /users/sean/collection/shows", [
      { last_collected_at: "2020-01-01T00:00:00.000Z", show: mandalorian },
    ]);
    expect(
      (await fetchEntries("users/sean/collection")).map((e) => e.imdbId),
    ).toEqual(["tt8111088", "tt10665342"]);
    expect(calls.every((call) => !call.headers.has("Authorization"))).toBe(
      true,
    );
    expect(callsTo("/sync/collection/movies")).toHaveLength(0);
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

  it("reads a smart list in Trakt's rank order", async () => {
    route(
      "GET /smart-lists/silos/items",
      pages([
        [
          { rank: 1, type: "show", show: pitt },
          { rank: 2, type: "movie", movie: halloween },
          { rank: 3, type: "movie", movie: clerks },
        ],
      ]),
    );
    const { entries, complete } = await traktProvider.fetchSource(
      "smart-lists/silos",
      { connection: null },
    );
    expect(entries.map((e) => [e.type, e.imdbId, e.addedAt])).toEqual([
      ["series", "tt31938062", undefined],
      ["movie", "tt10665342", undefined],
      ["movie", "tt11128440", undefined],
    ]);
    expect(complete).toBe(true);
    expect(calls[0].headers.has("Authorization")).toBe(false);
  });

  it("caps a smart list at its best-ranked Titles", async () => {
    route("GET /smart-lists/everything/items", (call) => {
      const page = Number(call.url.searchParams.get("page"));
      return json(
        Array.from({ length: 250 }, (_, i) => ({
          rank: page * 1000 + i,
          type: "movie",
          movie: {
            title: "x",
            ids: {
              trakt: page * 1000 + i,
              imdb: `tt${4000000 + page * 1000 + i}`,
            },
          },
        })),
        { headers: { "X-Pagination-Page-Count": "40" } },
      );
    });
    const snapshot = await traktProvider.fetchSource("smart-lists/everything", {
      connection: null,
    });
    expect(snapshot.entries).toHaveLength(1000);
    expect(snapshot.complete).toBe(false);
    expect(callsTo("/smart-lists/everything/items")).toHaveLength(4);
  });

  it("reads the user's own smart list through the Connection", async () => {
    route("GET /smart-lists/private-picks/items", [
      { rank: 1, type: "movie", movie: clerks },
    ]);
    await expect(
      fetchEntries("me/smart-lists/private-picks"),
    ).rejects.toMatchObject({ reason: "needs_connection" });
    expect(
      (await fetchEntries("me/smart-lists/private-picks", connection())).map(
        (e) => e.imdbId,
      ),
    ).toEqual(["tt11128440"]);
    expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("reads up next as shows, oldest watched first", async () => {
    route("GET /users/hidden/dropped", []);
    route("GET /users/hidden/progress_watched", []);
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
    route("GET /users/hidden/dropped", []);
    route("GET /users/hidden/progress_watched", []);
    route("GET /sync/progress/up_next", status(403));
    route("GET /sync/progress/watched", (call) => {
      expect(call.url.searchParams.get("hide_completed")).toBe("true");
      expect(call.url.searchParams.get("extended")).toBe("full");
      return json([
        {
          show: { ...pitt, last_aired: "2026-09-10T02:00:00.000Z" },
          progress: { last_watched_at: "2026-09-01T00:00:00.000Z" },
        },
      ]);
    });
    expect(await fetchEntries("me/up-next", connection())).toMatchObject([
      { imdbId: "tt31938062", latestEpisodeAt: "2026-09-10T02:00:00.000Z" },
    ]);
  });

  it("leaves out of up next the shows the user dropped or hid from progress", async () => {
    route("GET /users/hidden/dropped", (call) => {
      expect(call.url.searchParams.get("type")).toBe("show");
      return json([{ type: "show", show: mandalorian }]);
    });
    route("GET /users/hidden/progress_watched", (call) => {
      expect(call.url.searchParams.get("type")).toBe("show");
      return json([{ type: "show", show: clerksShow }]);
    });
    route(
      "GET /sync/progress/up_next",
      pages([
        [
          { show: clerksShow, progress: { last_watched_at: null } },
          { show: mandalorian, progress: { last_watched_at: null } },
          { show: pitt, progress: { last_watched_at: null } },
        ],
      ]),
    );
    expect(
      (await fetchEntries("me/up-next", connection())).map((e) => e.imdbId),
    ).toEqual(["tt31938062"]);
  });

  it("dates each up next show by its latest aired episode", async () => {
    route("GET /users/hidden/dropped", []);
    route("GET /users/hidden/progress_watched", []);
    route(
      "GET /sync/progress/up_next",
      pages([
        [
          {
            show: { ...pitt, last_aired: "2026-11-18T02:00:00.000Z" },
            progress: { last_watched_at: "2026-11-12T20:00:00.000Z" },
          },
          {
            show: { ...mandalorian, last_aired: "2999-01-01T00:00:00.000Z" },
            progress: { last_watched_at: "2026-11-15T20:00:00.000Z" },
          },
        ],
      ]),
    );
    const entries = await fetchEntries("me/up-next", connection());
    expect(entries.map((e) => [e.imdbId, e.latestEpisodeAt])).toEqual([
      ["tt31938062", "2026-11-18T02:00:00.000Z"],
      ["tt8111088", undefined],
    ]);
  });

  it("reads Continue Watching as paused movies and the shows of paused episodes", async () => {
    route(
      "GET /sync/playback/movies",
      pages([
        [
          {
            progress: 25,
            paused_at: "2026-11-10T00:00:00.000Z",
            id: 1,
            type: "movie",
            movie: clerks,
          },
        ],
      ]),
    );
    const episode = (number: number, pausedAt: string) => ({
      progress: 40,
      paused_at: pausedAt,
      id: 10 + number,
      type: "episode",
      episode: { season: 1, number, ids: { trakt: 100 + number } },
      show: pitt,
    });
    route(
      "GET /sync/playback/episodes",
      pages([
        [
          episode(3, "2026-11-15T00:00:00.000Z"),
          episode(2, "2026-11-01T00:00:00.000Z"),
        ],
      ]),
    );
    const snapshot = await traktProvider.fetchSource("me/continue-watching", {
      connection: connection(),
    });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries.map((e) => [e.type, e.imdbId, e.addedAt])).toEqual([
      ["movie", "tt11128440", "2026-11-10T00:00:00.000Z"],
      ["series", "tt31938062", "2026-11-15T00:00:00.000Z"],
    ]);
    expect(
      callsTo("/sync/playback/movies")[0]?.headers.get("Authorization"),
    ).toBe("Bearer token-1");
    expect(
      await unavailableReason(
        traktProvider.fetchSource("me/continue-watching", { connection: null }),
      ),
    ).toBe("needs_connection");
  });

  function pinToday() {
    const today = new Date().toISOString().slice(0, 10);
    vi.setSystemTime(new Date(`${today}T12:00:00.000Z`));
    return today;
  }

  it("reads a public calendar of the next 30 days, one entry per show", async () => {
    const today = pinToday();
    const aired = (number: number, at: string) => ({
      show: pitt,
      episode: { season: 2, number, ids: { trakt: 200 + number } },
      first_aired: at,
      released: null,
    });
    route("GET /calendars/all/shows/premieres/" + today + "/30", [
      aired(1, "2026-11-20T02:00:00.000Z"),
      { ...aired(1, "2026-11-18T02:00:00.000Z"), show: mandalorian },
      aired(2, "2026-11-27T02:00:00.000Z"),
    ]);
    const snapshot = await traktProvider.fetchSource(
      "calendars/shows/premieres",
      { connection: null },
    );
    expect(snapshot).toMatchObject({ complete: true });
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ type: "series", imdbId: "tt8111088" }),
      expect.objectContaining({ type: "series", imdbId: "tt31938062" }),
    ]);
    expect(snapshot.entries.every((e) => e.addedAt === undefined)).toBe(true);
    const [call] = callsTo(`/calendars/all/shows/premieres/${today}/30`);
    expect(call?.headers.get("Authorization")).toBeNull();
    expect(call?.url.searchParams.get("page")).toBeNull();
  });

  it("reads the movie calendars by release date", async () => {
    const today = pinToday();
    route(`GET /calendars/all/dvd/${today}/30`, [
      { released: "2026-11-30", movie: halloween },
      { released: "2026-11-18", movie: clerks },
    ]);
    expect(
      (await fetchEntries("calendars/dvd")).map((e) => [e.type, e.imdbId]),
    ).toEqual([
      ["movie", "tt11128440"],
      ["movie", "tt10665342"],
    ]);
  });

  it("reads the user's calendar of shows and movies through the Connection", async () => {
    const today = pinToday();
    route(`GET /calendars/my/shows/${today}/30`, [
      {
        show: pitt,
        episode: { season: 2, number: 1, ids: { trakt: 201 } },
        first_aired: "2026-11-19T09:00:00.000Z",
        released: null,
      },
    ]);
    route(`GET /calendars/my/movies/${today}/30`, [
      { released: "2026-11-18", movie: clerks },
    ]);
    expect(
      (await fetchEntries("me/calendar", connection())).map((e) => [
        e.type,
        e.imdbId,
      ]),
    ).toEqual([
      ["movie", "tt11128440"],
      ["series", "tt31938062"],
    ]);
    expect(
      callsTo(`/calendars/my/movies/${today}/30`)[0]?.headers.get(
        "Authorization",
      ),
    ).toBe("Bearer token-1");
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

  it("follows every page of watched titles", async () => {
    route(
      "GET /users/sean/watched/movies",
      pages([
        [{ last_watched_at: "2025-01-01T00:00:00.000Z", movie: clerks }],
        [{ last_watched_at: "2025-02-01T00:00:00.000Z", movie: halloween }],
      ]),
    );
    route(
      "GET /users/sean/watched/shows",
      pages([
        [{ last_watched_at: "2024-01-01T00:00:00.000Z", show: pitt }],
        [{ last_watched_at: "2024-02-01T00:00:00.000Z", show: mandalorian }],
      ]),
    );
    const { entries, complete } = await traktProvider.fetchSource(
      "users/sean/history",
      { connection: null },
    );
    expect(entries.map((e) => e.imdbId)).toEqual([
      "tt31938062",
      "tt8111088",
      "tt11128440",
      "tt10665342",
    ]);
    expect(complete).toBe(true);
    expect(
      callsTo("/users/sean/watched/movies").map((call) =>
        call.url.searchParams.get("limit"),
      ),
    ).toEqual(["250", "250"]);
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

describe("Trakt Connection sources", () => {
  beforeEach(() => {
    route("GET /users/likes/lists", pages([[]]));
    route("GET /users/me/lists/collaborations", []);
  });

  it("offers the user's own lists and smart lists", async () => {
    route("GET /users/me/lists", [
      { name: "Favs", ids: { trakt: 7, slug: "Favs" } },
    ]);
    route("GET /users/me/smart-lists", [
      {
        name: "Silos",
        media_type: "shows",
        ids: { trakt: 42, slug: "silos" },
      },
    ]);
    const sources = await traktProvider.listConnectionSources?.(connection());
    expect(
      sources?.map((source) => [
        source.ref,
        source.label,
        source.defaultDisplayMode,
      ]),
    ).toEqual([
      ["me/lists/favs", "Favs", "split"],
      ["me/smart-lists/silos", "Silos", "series"],
    ]);
  });

  it("still offers the lists when smart lists fail", async () => {
    vi.spyOn(console, "error");
    route("GET /users/me/lists", [
      { name: "Favs", ids: { trakt: 7, slug: "favs" } },
    ]);
    route("GET /users/me/smart-lists", status(500));
    const sources = await traktProvider.listConnectionSources?.(connection());
    expect(sources?.map((source) => source.ref)).toEqual(["me/lists/favs"]);
  });

  const otherList = (owner: string, slug: string, trakt: number) => ({
    name: ` ${slug} `,
    privacy: "public",
    ids: { trakt, slug },
    user: { username: owner, ids: { slug: owner.toLowerCase() } },
  });

  it("offers liked lists and collaboration lists at their owner's profile", async () => {
    route("GET /users/me/lists", [
      { name: "Favs", ids: { trakt: 7, slug: "favs" } },
    ]);
    route("GET /users/me/smart-lists", []);
    route(
      "GET /users/likes/lists",
      pages([
        [
          {
            liked_at: "2023-11-06T19:43:36.000Z",
            type: "list",
            list: otherList("Acoucalancha", "upcoming-series", 6434384),
          },
          {
            liked_at: "2023-11-06T19:43:36.000Z",
            type: "list",
            list: { ...otherList("leo", "favs", 7), name: "Favs" },
          },
          { liked_at: "2023-11-06T19:43:36.000Z", type: "list", list: null },
        ],
      ]),
    );
    route("GET /users/me/lists/collaborations", [
      otherList("Justin", "summer-shows", 23526133),
      otherList("Acoucalancha", "upcoming-series", 6434384),
    ]);
    const sources = await traktProvider.listConnectionSources?.(connection());
    expect(
      sources?.map((source) => [source.ref, source.label, source.kind]),
    ).toEqual([
      ["me/lists/favs", "Favs", "list"],
      ["users/acoucalancha/lists/upcoming-series", "upcoming-series", "list"],
      ["users/justin/lists/summer-shows", "summer-shows", "list"],
    ]);
    expect(
      callsTo("/users/likes/lists")[0]?.url.searchParams.get("limit"),
    ).toBe("250");
  });

  it("still offers the user's own lists when likes and collaborations fail", async () => {
    vi.spyOn(console, "error");
    route("GET /users/me/lists", [
      { name: "Favs", ids: { trakt: 7, slug: "favs" } },
    ]);
    route("GET /users/me/smart-lists", []);
    route("GET /users/likes/lists", status(500));
    route("GET /users/me/lists/collaborations", status(500));
    const sources = await traktProvider.listConnectionSources?.(connection());
    expect(sources?.map((source) => source.ref)).toEqual(["me/lists/favs"]);
  });
});
