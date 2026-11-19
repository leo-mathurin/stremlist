import { ADDON_VERSION } from "@stremlist/shared/constants";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { simklProvider } from "../../simkl";
import {
  calls,
  clearCalls,
  json,
  resetSimklTest,
  restoreStubs,
  routes,
} from "./harness";

const server = useMswServer();

const MOVIES = [
  {
    title: "The Odyssey",
    url: "/movies/2604475/the-odyssey",
    release_date: "07/17/2026",
    rank: 12,
    ids: {
      simkl_id: 2604475,
      slug: "the-odyssey",
      imdb: "tt33764258",
      tmdb: "1368337",
    },
  },
  { title: "Broken", ids: { imdb: "tt0000001" } },
];
const ANIME = [
  {
    title: "Black Clover Second Season",
    release_date: "10/03/2026",
    anime_type: "tv",
    ids: {
      simkl_id: 2829490,
      slug: "black-clover-2nd-season",
      imdb: "tt7441658",
      tmdb: "336735",
    },
  },
  {
    title: "Demon Slayer: Infinity Castle",
    release_date: "07/18/2025",
    anime_type: "movie",
    ids: { simkl_id: 2414064, imdb: "tt32820897", tmdb: "1311031" },
  },
  {
    title: "Black Clover",
    anime_type: "tv",
    ids: { simkl_id: 37227, slug: "black-clover", imdb: "tt7441658" },
  },
  {
    title: "Mouse Cursor",
    anime_type: "tv",
    ids: { simkl_id: 3004128, tmdb: "334779" },
  },
];

beforeEach(() => {
  resetSimklTest(server);
  routes.set("GET /discover/trending/movies/week_100.json", () => MOVIES);
  routes.set("GET /discover/trending/anime/week_100.json", () => ANIME);
});
afterEach(restoreStubs);

describe("simkl trending charts", () => {
  it("read the week's CDN file with no Connection, in rank order", async () => {
    const snapshot = await simklProvider.fetchSource("trending/movies", {
      connection: null,
    });
    expect(snapshot).toEqual({
      entries: [
        {
          imdbId: "tt33764258",
          externalIds: {
            simkl: 2604475,
            tmdb: { id: 1368337, type: "movie" },
          },
          type: "movie",
          title: "The Odyssey",
          year: 2026,
          sourceUrl: "https://simkl.com/movies/2604475/the-odyssey",
        },
      ],
      complete: true,
    });
    const [call] = calls;
    expect(`${call.url.origin}${call.url.pathname}`).toBe(
      "https://data.simkl.in/discover/trending/movies/week_100.json",
    );
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      client_id: "client-123",
      "app-name": "stremlist",
      "app-version": ADDON_VERSION,
    });
    expect(call.headers.get("Authorization")).toBeNull();
    expect(call.headers.get("User-Agent")).toMatch(/^Stremlist\//);
  });

  it("keep one entry per IMDb ID and type anime films as movies", async () => {
    const { entries } = await simklProvider.fetchSource("trending/anime", {
      connection: null,
    });
    expect(
      entries.map((entry) => [entry.title, entry.type, entry.imdbId]),
    ).toEqual([
      ["Black Clover Second Season", "series", "tt7441658"],
      ["Demon Slayer: Infinity Castle", "movie", "tt32820897"],
      ["Mouse Cursor", "series", undefined],
    ]);
    expect(entries[2].externalIds).toEqual({
      simkl: 3004128,
      tmdb: { id: 334779, type: "series" },
    });
    expect(entries.every((entry) => entry.sourceUrl)).toBe(true);
  });

  it("share one read of a file while the CDN keeps it", async () => {
    const first = await simklProvider.fetchSource("trending/movies", {
      connection: null,
    });
    first.entries[0].title = "Changed by a reader";
    const second = await simklProvider.fetchSource("trending/movies", {
      connection: null,
    });
    expect(calls).toHaveLength(1);
    expect(second.entries[0].title).toBe("The Odyssey");

    clearCalls();
    await simklProvider.fetchSource("trending/movies", {
      connection: null,
      forceRefresh: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("read again after a failed read", async () => {
    routes.set("GET /discover/trending/movies/week_100.json", () =>
      json({ error: "down" }, 503),
    );
    await expect(
      simklProvider.fetchSource("trending/movies", { connection: null }),
    ).rejects.toThrow();
    routes.set("GET /discover/trending/movies/week_100.json", () => MOVIES);
    const { entries } = await simklProvider.fetchSource("trending/movies", {
      connection: null,
    });
    expect(entries).toHaveLength(1);
  });

  it("need the app's client ID, as every Simkl call", async () => {
    vi.stubEnv("SIMKL_CLIENT_ID", "");
    await expect(
      simklProvider.fetchSource("trending/tv", { connection: null }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("validate with no Connection and no request, named after Simkl", async () => {
    await expect(
      simklProvider.validateSource("trending/tv", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "trending/tv",
      suggestedTitle: "Simkl Trending TV",
      defaultDisplayMode: "series",
    });
    await expect(
      simklProvider.validateSource("trending/books", { connection: null }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(calls).toEqual([]);
  });

  it("stay fresh for hours, today's for an hour, as the library", () => {
    expect(simklProvider.freshnessFor?.("trending/anime")).toBe(6 * 3_600_000);
    expect(simklProvider.freshnessFor?.("trending/tv/month")).toBe(
      6 * 3_600_000,
    );
    expect(simklProvider.freshnessFor?.("dvd/releases")).toBe(6 * 3_600_000);
    expect(simklProvider.freshnessFor?.("trending/movies/today")).toBe(
      3_600_000,
    );
    expect(simklProvider.freshnessFor?.("me/ratings")).toBe(3_600_000);
  });
});

describe("simkl charts of other periods, genres and DVD releases", () => {
  const paths = () => calls.map((call) => call.url.pathname);

  it("read today's and the month's files, named after Simkl", async () => {
    routes.set("GET /discover/trending/movies/today_100.json", () => MOVIES);
    routes.set("GET /discover/trending/anime/month_100.json", () => ANIME);
    const today = await simklProvider.fetchSource("trending/movies/today", {
      connection: null,
    });
    expect(today.entries.map((entry) => entry.imdbId)).toEqual(["tt33764258"]);
    const month = await simklProvider.fetchSource("trending/anime/month", {
      connection: null,
    });
    expect(month.entries).toHaveLength(3);
    expect(paths()).toEqual([
      "/discover/trending/movies/today_100.json",
      "/discover/trending/anime/month_100.json",
    ]);
    await expect(
      simklProvider.validateSource("trending/tv/today", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "trending/tv/today",
      suggestedTitle: "Simkl Trending TV Today",
      defaultDisplayMode: "series",
    });
    await expect(
      simklProvider.validateSource("trending/movies/year", {
        connection: null,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("read the DVD releases as movies", async () => {
    routes.set("GET /discover/dvd/releases_100.json", () => [
      {
        title: "Heartland",
        release_date: "11/13/2026",
        dvd_date: "11/13/2026",
        ids: { simkl_id: 2956225, imdb: "tt38213251", tmdb: "1543469" },
      },
    ]);
    const { entries } = await simklProvider.fetchSource("dvd/releases", {
      connection: null,
    });
    expect(entries).toEqual([
      {
        imdbId: "tt38213251",
        externalIds: { simkl: 2956225, tmdb: { id: 1543469, type: "movie" } },
        type: "movie",
        title: "Heartland",
        year: 2026,
        sourceUrl: "https://simkl.com/movies/2956225/",
      },
    ]);
    await expect(
      simklProvider.validateSource("dvd/releases", { connection: null }),
    ).resolves.toMatchObject({
      ok: true,
      suggestedTitle: "Simkl DVD Releases",
      defaultDisplayMode: "movie",
    });
  });

  it("validate a genre that Simkl's index lists, and read its month file", async () => {
    routes.set("GET /discover/trending/movies/genre/index.json", () => [
      { name: "Horror", slug: "horror", count: 500 },
      { name: "Erotica", slug: "erotica", count: 181 },
    ]);
    routes.set(
      "GET /discover/trending/movies/genre/horror_month_500.json",
      () => MOVIES,
    );
    await expect(
      simklProvider.validateSource("trending/movies/genre/horror", {
        connection: null,
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "trending/movies/genre/horror",
      suggestedTitle: "Simkl Trending Horror Movies",
      defaultDisplayMode: "movie",
    });
    await expect(
      simklProvider.validateSource("trending/movies/genre/western", {
        connection: null,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(paths()).toEqual(["/discover/trending/movies/genre/index.json"]);

    const { entries } = await simklProvider.fetchSource(
      "trending/movies/genre/horror",
      { connection: null },
    );
    expect(entries.map((entry) => entry.title)).toEqual(["The Odyssey"]);
    expect(paths()).toContain(
      "/discover/trending/movies/genre/horror_month_500.json",
    );
  });

  it("never offer or read an adult genre", async () => {
    for (const ref of [
      "trending/movies/genre/erotica",
      "trending/anime/genre/hentai",
    ]) {
      await expect(
        simklProvider.validateSource(ref, { connection: null }),
      ).resolves.toEqual({ ok: false, reason: "not_found" });
      await expect(
        simklProvider.fetchSource(ref, { connection: null }),
      ).rejects.toMatchObject({ reason: "not_found" });
    }
    expect(calls).toEqual([]);
  });

  it("report a genre file that Simkl dropped as not found", async () => {
    await expect(
      simklProvider.fetchSource("trending/tv/genre/podcast", {
        connection: null,
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
  });
});
