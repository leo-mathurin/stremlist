import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { r2Objects } from "../../../test/helpers/r2.test-utils";
import { simklProvider } from "../../simkl";
import {
  ageLibrary,
  apiCalls,
  clearCalls,
  connection,
  ctx,
  resetSimklTest,
  restoreStubs,
  routes,
} from "./harness";
import { activities } from "./simkl.fixture";

const server = useMswServer();

const PLAYBACK_KEY = "connections/acc-1/simkl/playback.json";

const SESSIONS = [
  {
    id: 73273545,
    progress: 41,
    paused_at: "2026-11-17T18:27:13Z",
    type: "episode",
    episode: { season: 1, number: 2, title: "The Kingsroad" },
    show: {
      title: "Game of Thrones",
      year: 2011,
      ids: { simkl: 17465, imdb: "tt0944947", tmdb: "1399" },
    },
  },
  {
    id: 73273503,
    progress: 31,
    paused_at: "2026-11-17T18:27:09Z",
    type: "movie",
    movie: {
      title: "Inception",
      year: 2010,
      ids: { simkl: 472214, slug: "inception", imdb: "tt1375666" },
    },
  },
  {
    id: 73270000,
    progress: 12,
    paused_at: "2026-11-10T08:00:00Z",
    type: "episode",
    episode: { season: 1, number: 1 },
    show: { title: "Game of Thrones", year: 2011, ids: { simkl: 17465 } },
  },
  {
    id: 61873794,
    progress: 63,
    paused_at: "2026-10-28T05:22:13Z",
    type: "episode",
    episode: { season: 1, number: 3, tvdb_season: 1, tvdb_number: 3 },
    anime: {
      title: "Frieren: Beyond Journey's End",
      year: 2023,
      anime_type: "tv",
      ids: { simkl: 1990194, imdb: "tt22248376", tmdb: "209867" },
    },
  },
];

beforeEach(() => {
  resetSimklTest(server);
  routes.set("GET /sync/playback", () => SESSIONS);
});
afterEach(restoreStubs);

const playbackReads = () =>
  apiCalls().filter((call) => call === "GET /sync/playback");

describe("simkl continue watching", () => {
  it("lists each paused title once, the oldest pause first", async () => {
    const { entries, complete } = await simklProvider.fetchSource(
      "me/continue-watching",
      ctx(),
    );
    expect(complete).toBe(true);
    expect(
      entries.map((entry) => [entry.title, entry.type, entry.addedAt]),
    ).toEqual([
      ["Frieren: Beyond Journey's End", "series", "2026-10-28T05:22:13Z"],
      ["Inception", "movie", "2026-11-17T18:27:09Z"],
      ["Game of Thrones", "series", "2026-11-17T18:27:13Z"],
    ]);
    expect(entries[2]).toMatchObject({
      imdbId: "tt0944947",
      externalIds: { simkl: 17465, tmdb: { id: 1399, type: "series" } },
      sourceUrl: "https://simkl.com/tv/17465/",
    });
    expect(entries[0].sourceUrl).toBe("https://simkl.com/anime/1990194/");
  });

  it("reads the sessions again only when activities move, or after a day", async () => {
    await simklProvider.fetchSource("me/continue-watching", ctx());
    expect(playbackReads()).toHaveLength(1);

    clearCalls();
    ageLibrary();
    await simklProvider.fetchSource("me/continue-watching", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);

    clearCalls();
    ageLibrary();
    routes.set("GET /sync/activities", () =>
      activities({
        all: "2026-10-02T10:00:00Z",
        movies: { playback: "2026-10-02T10:00:00Z" },
      }),
    );
    routes.set("GET /sync/playback", () => SESSIONS.slice(0, 1));
    const { entries } = await simklProvider.fetchSource(
      "me/continue-watching",
      ctx(),
    );
    expect(playbackReads()).toHaveLength(1);
    expect(entries.map((entry) => entry.title)).toEqual(["Game of Thrones"]);

    clearCalls();
    const stored = z
      .object({})
      .loose()
      .parse(JSON.parse(r2Objects.get(PLAYBACK_KEY) ?? "{}"));
    r2Objects.set(
      PLAYBACK_KEY,
      JSON.stringify({ ...stored, fetchedAt: Date.now() - 25 * 3_600_000 }),
    );
    await simklProvider.fetchSource("me/continue-watching", ctx());
    expect(playbackReads()).toHaveLength(1);
  });

  it("never uses the sessions of another authorization", async () => {
    await simklProvider.fetchSource("me/continue-watching", ctx());
    clearCalls();
    await simklProvider.fetchSource("me/continue-watching", {
      connection: { ...connection, authorization: "authorization-2" },
    });
    expect(playbackReads()).toHaveLength(1);
  });

  it("keeps the empty list of an account with no activity yet", async () => {
    routes.set("GET /sync/activities", () => ({ all: null }));
    routes.set("GET /sync/playback", () => []);
    await expect(
      simklProvider.fetchSource("me/continue-watching", ctx()),
    ).resolves.toEqual({ entries: [], complete: true });
    clearCalls();
    ageLibrary();
    await simklProvider.fetchSource("me/continue-watching", ctx());
    expect(playbackReads()).toEqual([]);
  });
});
