import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
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
import {
  movie,
  seedAccount,
  seedList,
} from "../../test/helpers/account.fixture.js";
import {
  configBody,
  createdAccountBody,
  metaBody,
  metasBody,
  readJson,
} from "../../test/helpers/json.js";
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
const TMDB_SHAWSHANK = "https://image.tmdb.org/t/p/w500/shawshank-tmdb.jpg";
const RPDB_SHAWSHANK =
  "https://api.ratingposterdb.com/rpdb-key/imdb/poster-default/tt0111161.jpg?fallback=true";

let tmdbFinds: string[] = [];

function tmdbFind(status = 200) {
  server.use(
    http.get("https://api.themoviedb.org/3/find/:id", ({ params }) => {
      const id = String(params.id);
      tmdbFinds.push(id);
      if (status !== 200) return new HttpResponse("down", { status });
      return HttpResponse.json({
        movie_results:
          id === SHAWSHANK.id ? [{ poster_path: "/shawshank-tmdb.jpg" }] : [],
        tv_results: [],
      });
    }),
  );
}

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
  tmdbFinds = [];
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  imdb.watchlists.set("ur12345678", [SHAWSHANK, ALIEN]);
  server.use(imdb.handler, cinemetaWithoutTitles);
  resetPosterMemory();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("poster source in Stremio responses", () => {
  it("keeps IMDb posters by default and never asks TMDB", async () => {
    tmdbFind();
    const accountId = seedWithList({});

    expect(await catalogPosters(accountId)).toEqual({
      [SHAWSHANK.id]: IMDB_POSTER,
      [ALIEN.id]: ALIEN.poster,
    });
    expect(tmdbFinds).toEqual([]);
  });

  it("shows TMDB posters, with the IMDb poster when TMDB has none", async () => {
    tmdbFind();
    const accountId = seedWithList({ poster_source: "tmdb" });

    expect(await catalogPosters(accountId)).toEqual({
      [SHAWSHANK.id]: TMDB_SHAWSHANK,
      [ALIEN.id]: ALIEN.poster,
    });
    expect(
      db.getTable("title_posters").map(({ source, imdb_id, poster }) => ({
        source,
        imdb_id,
        poster,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          source: "tmdb",
          imdb_id: SHAWSHANK.id,
          poster: "/shawshank-tmdb.jpg",
        },
        { source: "tmdb", imdb_id: ALIEN.id, poster: null },
      ]),
    );
  });

  it("reuses the stored posters instead of asking TMDB again", async () => {
    tmdbFind();
    const accountId = seedWithList({ poster_source: "tmdb" });
    await catalogPosters(accountId);
    expect(tmdbFinds).toHaveLength(2);

    resetPosterMemory();
    expect((await catalogPosters(accountId))[SHAWSHANK.id]).toBe(
      TMDB_SHAWSHANK,
    );
    expect(tmdbFinds).toHaveLength(2);
  });

  it("applies the choice of each Account to its own Catalogs only", async () => {
    tmdbFind();
    const tmdbAccount = seedWithList({ poster_source: "tmdb" });
    const imdbAccount = seedWithList({}, OTHER_LIST_ID);

    expect((await catalogPosters(tmdbAccount))[SHAWSHANK.id]).toBe(
      TMDB_SHAWSHANK,
    );
    expect(
      (await catalogPosters(imdbAccount, OTHER_LIST_ID))[SHAWSHANK.id],
    ).toBe(IMDB_POSTER);
  });

  it("shows RPDB posters with a key, and IMDb posters without one", async () => {
    tmdbFind();
    const withKey = seedWithList({
      poster_source: "rpdb",
      rpdb_api_key: "rpdb-key",
    });
    const withoutKey = seedWithList({ poster_source: "rpdb" }, OTHER_LIST_ID);

    expect((await catalogPosters(withKey))[SHAWSHANK.id]).toBe(RPDB_SHAWSHANK);
    expect(
      (await catalogPosters(withoutKey, OTHER_LIST_ID))[SHAWSHANK.id],
    ).toBe(IMDB_POSTER);
    expect(tmdbFinds).toEqual([]);
  });

  it("keeps the RPDB key unused while another source is chosen", async () => {
    tmdbFind();
    const accountId = seedWithList({
      poster_source: "tmdb",
      rpdb_api_key: "rpdb-key",
    });

    expect((await catalogPosters(accountId))[SHAWSHANK.id]).toBe(
      TMDB_SHAWSHANK,
    );
  });

  it("keeps IMDb posters while TMDB fails, and stores nothing", async () => {
    vi.spyOn(console, "warn");
    tmdbFind(503);
    const accountId = seedWithList({ poster_source: "tmdb" });

    expect(await catalogPosters(accountId)).toEqual({
      [SHAWSHANK.id]: IMDB_POSTER,
      [ALIEN.id]: ALIEN.poster,
    });
    expect(db.getTable("title_posters")).toEqual([]);
    const calls = tmdbFinds.length;
    await catalogPosters(accountId);
    expect(tmdbFinds).toHaveLength(calls);
  });

  it("shows the TMDB poster on the meta of a movie", async () => {
    tmdbFind();
    const accountId = seedWithList({ poster_source: "tmdb" });

    const res = await app.request(`/${accountId}/meta/movie/tt0111161.json`);
    const { meta } = await readJson(res, metaBody);
    expect(meta).toMatchObject({ id: SHAWSHANK.id, poster: TMDB_SHAWSHANK });
  });

  it("keeps IMDb posters when TMDB is not configured", async () => {
    vi.stubEnv("TMDB_API_KEY", "");
    tmdbFind();
    const accountId = seedWithList({ poster_source: "tmdb" });

    expect((await catalogPosters(accountId))[SHAWSHANK.id]).toBe(IMDB_POSTER);
    expect(tmdbFinds).toEqual([]);
  });
});

describe("saving the poster source", () => {
  beforeEach(() => {
    tmdbFind();
  });

  const list = {
    provider: "imdb",
    sourceRef: "ur12345678",
    sortOption: "added_at-asc",
  };

  async function save(accountId: string, body: Record<string, unknown>) {
    return app.request(`/${accountId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [list], ...body }),
    });
  }

  async function savedSource(accountId: string) {
    const res = await app.request(`/${accountId}/config`);
    return (await readJson(res, configBody)).posterSource;
  }

  it("starts new Accounts on IMDb", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [list] }),
    });
    const { accountId } = await readJson(res, createdAccountBody);
    expect(await savedSource(accountId)).toBe("imdb");
  });

  it("creates an Account with the source of its setup", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [list], posterSource: "tmdb" }),
    });
    const { accountId } = await readJson(res, createdAccountBody);
    expect(await savedSource(accountId)).toBe("tmdb");
  });

  it("saves the source, and an older client that omits it keeps it", async () => {
    const { id } = seedAccount({});
    expect(await savedSource(id)).toBe("imdb");

    expect((await save(id, { posterSource: "tmdb" })).status).toBe(200);
    expect(await savedSource(id)).toBe("tmdb");
    expect(db.getTable("accounts")[0].poster_source).toBe("tmdb");

    expect((await save(id, { rpdbApiKey: "" })).status).toBe(200);
    expect(await savedSource(id)).toBe("tmdb");

    expect((await save(id, { posterSource: "imdb" })).status).toBe(200);
    expect(await savedSource(id)).toBe("imdb");
  });

  it("keeps the RPDB key when another source is chosen", async () => {
    const { id } = seedAccount({});
    await save(id, { posterSource: "rpdb", rpdbApiKey: "rpdb-key" });
    await save(id, { posterSource: "tmdb", rpdbApiKey: "rpdb-key" });
    const res = await app.request(`/${id}/config`);
    expect(await readJson(res, configBody)).toMatchObject({
      posterSource: "tmdb",
      rpdbApiKey: "rpdb-key",
    });
  });

  it("turns RPDB on for an older client that sends only a key", async () => {
    const { id } = seedAccount({});
    expect((await save(id, { rpdbApiKey: "rpdb-key" })).status).toBe(200);
    expect(await savedSource(id)).toBe("rpdb");
  });

  it("refuses an unknown source", async () => {
    const { id } = seedAccount({});
    expect((await save(id, { posterSource: "fanart" })).status).toBe(400);
    expect(await savedSource(id)).toBe("imdb");
  });
});
