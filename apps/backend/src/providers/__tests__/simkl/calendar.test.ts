import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { simklProvider } from "../../simkl";
import {
  calls,
  clearCalls,
  ctx,
  resetSimklTest,
  restoreStubs,
  routes,
} from "./harness";

vi.mock("../../../lib/r2", async () => {
  return (await import("./mocks")).r2Module;
});
vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("../oauth-harness");
  return httpModule(await importOriginal());
});

const HOUR = 60 * 60_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/** Shapes from data.simkl.in/calendar/v2/{file}, 2026-11. */
function calendar(
  airings: [number, number][],
  metadata: Record<number, Record<string, unknown>> = {},
) {
  return {
    calendar: airings.map(([simkl, hours]) => ({
      simkl_id: simkl,
      date: at(hours),
      finale_type: null,
    })),
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([simkl, ids]) => [
        simkl,
        { title: `Title ${simkl}`, ids: { simkl_id: Number(simkl), ...ids } },
      ]),
    ),
  };
}

beforeEach(() => {
  resetSimklTest();
  // The library fixtures: The Walking Dead (2090) and Shingeki no Kyojin
  // Season 2 (439744) are in Watching; Charmed (297) is a series in Plan to
  // watch; Pulp Fiction (54130), Old Movie (999) and the anime film Attack
  // on Titan: The Last Attack (2544548, no IMDb ID) are movies in Plan to
  // watch.
  routes.set("GET /calendar/v2/tv.json", () =>
    calendar([
      // Aired two days ago, then next week: the next airing counts.
      [2090, -48],
      [297, 10],
      [2090, 50],
    ]),
  );
  routes.set("GET /calendar/v2/anime.json", () =>
    calendar(
      [
        // Aired this morning, then next week: the next airing counts.
        [439744, -6],
        [2544548, 30],
        [439744, 100],
      ],
      { 2544548: { imdb: "tt32820897", tmdb: "1333100" } },
    ),
  );
  routes.set("GET /calendar/v2/movie_release.json", () =>
    calendar([[999, 5]], { 999: { imdb: null, tmdb: "4242" } }),
  );
});
afterEach(restoreStubs);

describe("simkl airing soon", () => {
  it("lists the series in Watching and the movies in Plan to watch that air soon, the soonest first", async () => {
    const { entries, complete } = await simklProvider.fetchSource(
      "me/airing-soon",
      ctx(),
    );
    expect(complete).toBe(true);
    expect(entries.map((entry) => [entry.title, entry.type])).toEqual([
      ["Old Movie", "movie"],
      ["Attack on Titan: The Last Attack", "movie"],
      ["The Walking Dead", "series"],
      ["Shingeki no Kyojin Season 2", "series"],
    ]);
    // The calendar gives the IMDb ID that the library does not have.
    expect(entries[1].imdbId).toBe("tt32820897");
    expect(entries[0]).toMatchObject({
      imdbId: "tt0000999",
      externalIds: { simkl: 999, tmdb: { id: 4242, type: "movie" } },
    });
    expect(entries.every((entry) => entry.sourceUrl)).toBe(true);
    expect(entries.some((entry) => entry.addedAt)).toBe(false);
  });

  it("reads the calendar files with no token, once while the CDN keeps them", async () => {
    await simklProvider.fetchSource("me/airing-soon", ctx());
    const files = calls.filter((call) => call.url.host === "data.simkl.in");
    expect(files.map((call) => call.url.pathname).sort()).toEqual([
      "/calendar/v2/anime.json",
      "/calendar/v2/movie_release.json",
      "/calendar/v2/tv.json",
    ]);
    expect(files.every((call) => !call.headers.get("Authorization"))).toBe(
      true,
    );

    clearCalls();
    await simklProvider.fetchSource("me/airing-soon", ctx());
    expect(calls).toEqual([]);
  });

  it("needs a Connection", async () => {
    await expect(
      simklProvider.fetchSource("me/airing-soon", { connection: null }),
    ).rejects.toMatchObject({ reason: "needs_connection" });
    await expect(
      simklProvider.validateSource("me/airing-soon", ctx()),
    ).resolves.toEqual({
      ok: true,
      ref: "me/airing-soon",
      suggestedTitle: "Airing Soon",
      defaultDisplayMode: "split",
    });
  });
});
