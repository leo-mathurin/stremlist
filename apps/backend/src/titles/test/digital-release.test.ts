import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { movie } from "../../test/helpers/account.fixture";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import type { DigitalRelease } from "../digital-release";
import {
  awaitsDigitalRelease,
  fetchDigitalRelease,
  forgetDigitalReleases,
  withDigitalReleases,
} from "../digital-release";

const server = useMswServer();
const series = (id: string, overrides: Parameters<typeof movie>[1] = {}) =>
  movie(id, { ...overrides, type: "series" });
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const iso = (time: number) => new Date(time).toISOString();

let lookups: string[] = [];
const releases = new Map<string, { type: number; release_date: string }[][]>();

function serveReleaseDates() {
  server.use(
    http.get(
      "https://api.themoviedb.org/3/movie/:id/release_dates",
      ({ params }) => {
        const id = String(params.id);
        lookups.push(id);
        const countries = releases.get(id);
        if (!countries) return new HttpResponse(null, { status: 404 });
        return HttpResponse.json({
          id: 1,
          results: countries.map((release_dates, index) => ({
            iso_3166_1: `C${index}`,
            release_dates,
          })),
        });
      },
    ),
  );
}

beforeEach(() => {
  lookups = [];
  releases.clear();
  forgetDigitalReleases();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
  serveReleaseDates();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fetchDigitalRelease", () => {
  it("takes the first digital or physical release in any country", async () => {
    releases.set("tt1", [
      [
        { type: 3, release_date: "2026-09-01T00:00:00.000Z" },
        { type: 4, release_date: "2026-11-10T00:00:00.000Z" },
      ],
      [
        { type: 1, release_date: "2026-05-01T00:00:00.000Z" },
        { type: 5, release_date: "2026-10-20T00:00:00.000Z" },
        { type: 6, release_date: "2026-10-01T00:00:00.000Z" },
      ],
    ]);
    releases.set("tt2", [
      [{ type: 3, release_date: "2026-11-01T00:00:00.000Z" }],
    ]);

    expect(await fetchDigitalRelease("tt1")).toBe("2026-10-20T00:00:00.000Z");
    expect(await fetchDigitalRelease("tt2")).toBeNull();
    expect(await fetchDigitalRelease("tt3")).toBeNull();
  });
});

describe("withDigitalReleases", () => {
  const recent: StremioMeta & DigitalRelease = movie("tt10", {
    released: iso(NOW - 30 * DAY),
  });
  const old = movie("tt11", { released: iso(NOW - 400 * DAY) });
  const show = series("tt12", { released: iso(NOW - 30 * DAY) });

  it("asks TMDB only about recent movies", async () => {
    releases.set("tt10", [
      [{ type: 4, release_date: "2026-11-01T00:00:00.000Z" }],
    ]);

    const metas = await withDigitalReleases(
      [recent, old, show],
      () => undefined,
      NOW,
    );

    expect(lookups).toEqual(["tt10"]);
    expect(metas).toEqual([
      {
        ...recent,
        digitalReleased: "2026-11-01T00:00:00.000Z",
        digitalCheckedAt: iso(NOW),
      },
      old,
      show,
    ]);
  });

  it("reuses a known past release and rechecks a missing one after a day", async () => {
    const waiting: StremioMeta & DigitalRelease = movie("tt13", {
      released: iso(NOW - 10 * DAY),
    });
    const previous = new Map([
      [
        recent.id,
        {
          digitalReleased: "2026-11-01T00:00:00.000Z",
          digitalCheckedAt: iso(NOW - 20 * DAY),
        },
      ],
      [waiting.id, { digitalCheckedAt: iso(NOW - 2 * 60 * 60_000) }],
    ]);

    const metas = await withDigitalReleases(
      [recent, waiting],
      (id) => previous.get(id),
      NOW,
    );
    expect(lookups).toEqual([]);
    expect(metas.map((meta) => meta.digitalCheckedAt)).toEqual([
      iso(NOW - 20 * DAY),
      iso(NOW - 2 * 60 * 60_000),
    ]);

    releases.set("tt13", [
      [{ type: 4, release_date: "2026-11-30T00:00:00.000Z" }],
    ]);
    const later = NOW + DAY;
    const [, rechecked] = await withDigitalReleases(
      [recent, waiting],
      (id) => previous.get(id),
      later,
    );
    expect(lookups).toEqual(["tt13"]);
    expect(rechecked).toMatchObject({
      digitalReleased: "2026-11-30T00:00:00.000Z",
      digitalCheckedAt: iso(later),
    });
  });

  it("asks first about unchecked movies, then the oldest checks, past the cap", async () => {
    const movies = Array.from({ length: 60 }, (_, index) =>
      movie(`tt${100 + index}`, { released: iso(NOW - 30 * DAY) }),
    );
    const upcoming = movie("tt99", { released: iso(NOW + DAY) });
    const first = await withDigitalReleases(
      [upcoming, ...movies],
      () => undefined,
      NOW,
    );
    expect(lookups.sort()).toEqual(movies.slice(0, 50).map((meta) => meta.id));

    lookups = [];
    const known = new Map<string, StremioMeta & DigitalRelease>(
      first.map((meta) => [meta.id, meta]),
    );
    await withDigitalReleases(movies, (id) => known.get(id), NOW + DAY);
    expect(lookups).toEqual(
      expect.arrayContaining(movies.slice(50).map((meta) => meta.id)),
    );
    expect(lookups).toHaveLength(50);
  });

  it("leaves a movie unchecked when TMDB fails or is not configured", async () => {
    server.use(
      http.get(
        "https://api.themoviedb.org/3/movie/:id/release_dates",
        () => new HttpResponse("down", { status: 500 }),
      ),
    );
    const errors = vi.spyOn(console, "error");
    expect(await withDigitalReleases([recent], () => undefined, NOW)).toEqual([
      recent,
    ]);
    expect(errors).toHaveBeenCalledOnce();

    vi.stubEnv("TMDB_API_KEY", "");
    expect(await withDigitalReleases([recent], () => undefined, NOW)).toEqual([
      recent,
    ]);
  });
});

describe("awaitsDigitalRelease", () => {
  it("waits for recent movies that TMDB knows no past digital release of", () => {
    const released = iso(NOW - 30 * DAY);
    const checked = { digitalCheckedAt: iso(NOW) };
    expect(
      [
        { ...movie("tt20", { released }), ...checked },
        {
          ...movie("tt21", { released }),
          ...checked,
          digitalReleased: iso(NOW + DAY),
        },
        {
          ...movie("tt22", { released }),
          ...checked,
          digitalReleased: iso(NOW - DAY),
        },
        movie("tt23", { released }),
        { ...movie("tt24", { released: iso(NOW - 400 * DAY) }), ...checked },
        { ...series("tt25", { released }), ...checked },
      ].map((meta) => awaitsDigitalRelease(meta, NOW)),
    ).toEqual([true, true, false, false, false, false]);
  });
});
