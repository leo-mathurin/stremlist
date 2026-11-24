import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import app from "../../index.js";
import { forgetDigitalReleases } from "../digital-release";
import {
  movie,
  seedAccount,
  seedList,
} from "../../test/helpers/account.fixture.js";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils.js";
import {
  cinemetaWithoutTitles,
  FakeImdb,
} from "../../test/helpers/imdb.test-utils.js";
import { metasBody, readJson } from "../../test/helpers/json.js";
import { cache } from "../../test/helpers/list-cache.test-utils.js";
import { db, resetRpc } from "../../test/helpers/mock-supabase.js";
import { useMswServer } from "../../test/helpers/msw.test-utils.js";
import { resetR2 } from "../../test/helpers/r2.test-utils.js";

const server = useMswServer();
useBackgroundTasks();
const imdb = new FakeImdb();

const DAY = 24 * 60 * 60_000;
const daysAgo = (days: number) => {
  const date = new Date(Date.now() - days * DAY);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};
const STREAMING = movie("tt9100001", { released: daysAgo(80) });
const IN_CINEMAS = movie("tt9100002", { released: daysAgo(10) });
const CLASSIC = movie("tt0111161", { released: "1994-10-14T00:00:00.000Z" });
const DIGITAL = new Map([[STREAMING.id, daysAgo(20)]]);

let lookups: string[] = [];

beforeEach(() => {
  lookups = [];
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  forgetDigitalReleases();
  imdb.watchlists.set("ur12345678", [STREAMING, IN_CINEMAS, CLASSIC]);
  server.use(
    imdb.handler,
    cinemetaWithoutTitles,
    http.get(
      "https://api.themoviedb.org/3/movie/:id/release_dates",
      ({ params }) => {
        const id = String(params.id);
        lookups.push(id);
        const digital = DIGITAL.get(id);
        return HttpResponse.json({
          id: 1,
          results: [
            {
              iso_3166_1: "US",
              release_dates: [
                { type: 3, release_date: daysAgo(80) },
                ...(digital ? [{ type: 4, release_date: digital }] : []),
              ],
            },
          ],
        });
      },
    ),
  );
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function catalog(accountId: string, listId: string) {
  const res = await app.request(
    `/${accountId}/catalog/movie/wl-${listId}-movie.json`,
  );
  expect(res.status).toBe(200);
  return (await readJson(res, metasBody)).metas;
}

it("hides recent movies until their digital release, and never serves the dates", async () => {
  const { id: accountId } = seedAccount({});
  const { id: otherAccountId } = seedAccount({});
  const digital = seedList(accountId, {
    id: "6bde5e3d-617f-4912-950a-2f9acf815b7e",
    source_ref: "ur12345678",
    catalog_settings: { hideUnreleased: "digital" },
  });
  const cinema = seedList(otherAccountId, {
    id: "0f4ef1b5-0a8c-4a4e-9f1e-3b2c1d0e9a87",
    source_ref: "ur12345678",
    catalog_settings: { hideUnreleased: true },
  });

  const shown = await catalog(accountId, digital.id);
  expect(shown.map((meta) => meta.id)).toEqual([STREAMING.id, CLASSIC.id]);
  for (const meta of shown) {
    expect(meta).not.toHaveProperty("digitalReleased");
    expect(meta).not.toHaveProperty("digitalCheckedAt");
  }
  expect(lookups.sort()).toEqual([STREAMING.id, IN_CINEMAS.id]);

  expect(
    (await catalog(otherAccountId, cinema.id)).map((meta) => meta.id),
  ).toEqual([STREAMING.id, IN_CINEMAS.id, CLASSIC.id]);
});
