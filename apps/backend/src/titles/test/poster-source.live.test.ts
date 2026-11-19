import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, passthrough } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import app from "../../index.js";
import { resetPosterMemory } from "../title-posters";
import { resetTvdbToken } from "../tvdb";
import {
  movie,
  seedAccount,
  seedList,
} from "../../test/helpers/account.fixture.js";
import { metasBody, readJson } from "../../test/helpers/json.js";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils.js";
import {
  cinemetaWithoutTitles,
  FakeImdb,
} from "../../test/helpers/imdb.test-utils.js";
import { cache } from "../../test/helpers/list-cache.test-utils.js";
import { db, resetRpc } from "../../test/helpers/mock-supabase.js";
import { useMswServer } from "../../test/helpers/msw.test-utils.js";
import { resetR2 } from "../../test/helpers/r2.test-utils.js";

const server = useMswServer();
useBackgroundTasks();
const imdb = new FakeImdb();

const LIST_ID = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const OTHER_LIST_ID = "0f4ef1b5-0a8c-4a4e-9f1e-3b2c1d0e9a87";
const IMDB_POSTER = "https://m.media-amazon.com/images/M/shawshank.jpg";
const SHAWSHANK = movie("tt0111161", {
  name: "The Shawshank Redemption",
  poster: IMDB_POSTER,
});
const ALIEN = movie("tt0078748", {
  name: "Alien",
  poster: "https://m.media-amazon.com/images/M/alien.jpg",
});

function seedWithList(
  account: Parameters<typeof seedAccount>[0],
  listId = LIST_ID,
  metas: StremioMeta[] = [SHAWSHANK, ALIEN],
) {
  const { id } = seedAccount(account);
  seedList(id, { id: listId, source_ref: "ur12345678" });
  cache.seed(listId, metas);
  return id;
}

async function catalogPosters(accountId: string, listId = LIST_ID) {
  const res = await app.request(
    `/${accountId}/catalog/movie/wl-${listId}-movie.json`,
  );
  expect(res.status).toBe(200);
  const { metas } = await readJson(res, metasBody);
  return Object.fromEntries(metas.map((meta) => [meta.id, meta.poster]));
}

beforeEach(() => {
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  imdb.watchlists.set("ur12345678", [SHAWSHANK, ALIEN]);
  server.use(imdb.handler, cinemetaWithoutTitles);
  resetPosterMemory();
  vi.stubEnv("TMDB_API_KEY", "");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.runIf(process.env.TVDB_LIVE_API_KEY)("TheTVDB posters, live", () => {
  beforeEach(() => {
    vi.stubEnv("TVDB_API_KEY", process.env.TVDB_LIVE_API_KEY ?? "");
    server.use(
      http.all(/^https:\/\/[a-z0-9.-]*thetvdb\.com\//, () => passthrough()),
    );
  });
  beforeEach(() => {
    resetTvdbToken();
  });

  it("shows TheTVDB posters and stores them for every Account", async () => {
    const accountId = seedWithList({ poster_source: "tvdb" });

    const posters = await catalogPosters(accountId);
    for (const id of [SHAWSHANK.id, ALIEN.id]) {
      expect(posters[id]).toMatch(
        /^https:\/\/artworks\.thetvdb\.com\/.+\.(jpe?g|png|webp)$/u,
      );
    }
    expect(
      db
        .getTable("title_posters")
        .filter((row) => row.source === "tvdb")
        .map((row) => String(row.imdb_id))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([ALIEN.id, SHAWSHANK.id].sort((a, b) => a.localeCompare(b)));

    const imdbAccount = seedWithList({}, OTHER_LIST_ID);
    expect(
      (await catalogPosters(imdbAccount, OTHER_LIST_ID))[SHAWSHANK.id],
    ).toBe(IMDB_POSTER);
  });

  it("finds the poster of a series", async () => {
    const accountId = seedWithList({ poster_source: "tvdb" }, LIST_ID, [
      movie("tt1190634", {
        type: "series",
        name: "The Boys",
        poster: "https://m.media-amazon.com/images/M/boys.jpg",
      }),
    ]);
    const res = await app.request(
      `/${accountId}/catalog/series/wl-${LIST_ID}-series.json`,
    );
    const { metas } = await readJson(res, metasBody);
    expect(metas[0].poster).toMatch(/^https:\/\/artworks\.thetvdb\.com\//u);
  });
});
