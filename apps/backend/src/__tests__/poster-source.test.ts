import type { StremioMeta } from "@stremlist/shared/stremio.types";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import app from "../index.js";
import { resetPosterMemory } from "../titles/title-posters";
import { resetTvdbToken } from "../titles/tvdb";
import { movie, seedAccount, seedList } from "./helpers/fixtures.js";
import {
  configBody,
  createdAccountBody,
  metaBody,
  metasBody,
  readJson,
} from "./helpers/json.js";
import { cache } from "./helpers/mock-list-cache.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

vi.mock("../lib/supabase", () => import("./helpers/mock-supabase.js"));
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));
// A save prewarms its Lists in the background; these tests read the cache.
vi.mock("../services/list-prewarm", () => ({ prewarmLists: vi.fn() }));

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

/** TMDB's /find answers: Shawshank has a poster, Alien has none. */
function tmdbFind(status = 200) {
  return vi.fn((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.host !== "api.themoviedb.org") {
      throw new Error(`Unexpected request to ${url.host}`);
    }
    if (status !== 200) {
      return Promise.resolve(new Response("down", { status }));
    }
    const id = url.pathname.split("/").at(-1);
    return Promise.resolve(
      Response.json({
        movie_results:
          id === SHAWSHANK.id ? [{ poster_path: "/shawshank-tmdb.jpg" }] : [],
        tv_results: [],
      }),
    );
  });
}

function seedWithList(
  account: Parameters<typeof seedAccount>[0],
  listId = LIST_ID,
  metas: StremioMeta[] = [SHAWSHANK, ALIEN],
): string {
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
  cache.reset();
  resetPosterMemory();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("poster source in Stremio responses", () => {
  it("keeps IMDb posters by default and never asks TMDB", async () => {
    const fetch = tmdbFind();
    vi.stubGlobal("fetch", fetch);
    const accountId = seedWithList({});

    expect(await catalogPosters(accountId)).toEqual({
      [SHAWSHANK.id]: IMDB_POSTER,
      [ALIEN.id]: ALIEN.poster,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows TMDB posters, with the IMDb poster when TMDB has none", async () => {
    vi.stubGlobal("fetch", tmdbFind());
    const accountId = seedWithList({ poster_source: "tmdb" });

    expect(await catalogPosters(accountId)).toEqual({
      [SHAWSHANK.id]: TMDB_SHAWSHANK,
      [ALIEN.id]: ALIEN.poster,
    });
    // Each answer is stored for every Account, a missing poster included.
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
    const fetch = tmdbFind();
    vi.stubGlobal("fetch", fetch);
    const accountId = seedWithList({ poster_source: "tmdb" });
    await catalogPosters(accountId);
    expect(fetch).toHaveBeenCalledTimes(2);

    // A new instance has an empty memory and reads the stored posters.
    resetPosterMemory();
    expect((await catalogPosters(accountId))[SHAWSHANK.id]).toBe(
      TMDB_SHAWSHANK,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("applies the choice of each Account to its own Catalogs only", async () => {
    vi.stubGlobal("fetch", tmdbFind());
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
    const fetch = tmdbFind();
    vi.stubGlobal("fetch", fetch);
    const withKey = seedWithList({
      poster_source: "rpdb",
      rpdb_api_key: "rpdb-key",
    });
    const withoutKey = seedWithList({ poster_source: "rpdb" }, OTHER_LIST_ID);

    expect((await catalogPosters(withKey))[SHAWSHANK.id]).toBe(RPDB_SHAWSHANK);
    expect(
      (await catalogPosters(withoutKey, OTHER_LIST_ID))[SHAWSHANK.id],
    ).toBe(IMDB_POSTER);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the RPDB key unused while another source is chosen", async () => {
    vi.stubGlobal("fetch", tmdbFind());
    const accountId = seedWithList({
      poster_source: "tmdb",
      rpdb_api_key: "rpdb-key",
    });

    expect((await catalogPosters(accountId))[SHAWSHANK.id]).toBe(
      TMDB_SHAWSHANK,
    );
  });

  it("keeps IMDb posters while TMDB fails, and stores nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = tmdbFind(503);
    vi.stubGlobal("fetch", fetch);
    const accountId = seedWithList({ poster_source: "tmdb" });

    expect(await catalogPosters(accountId)).toEqual({
      [SHAWSHANK.id]: IMDB_POSTER,
      [ALIEN.id]: ALIEN.poster,
    });
    expect(db.getTable("title_posters")).toEqual([]);
    // After a failure, the next requests do not wait for TMDB.
    const calls = fetch.mock.calls.length;
    await catalogPosters(accountId);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("shows the TMDB poster on the meta of a movie", async () => {
    vi.stubGlobal("fetch", tmdbFind());
    const accountId = seedWithList({ poster_source: "tmdb" });

    const res = await app.request(`/${accountId}/meta/movie/tt0111161.json`);
    const { meta } = await readJson(res, metaBody);
    expect(meta).toMatchObject({ id: SHAWSHANK.id, poster: TMDB_SHAWSHANK });
  });

  it("keeps IMDb posters when TMDB is not configured", async () => {
    vi.stubEnv("TMDB_API_KEY", "");
    const fetch = tmdbFind();
    vi.stubGlobal("fetch", fetch);
    const accountId = seedWithList({ poster_source: "tmdb" });

    expect((await catalogPosters(accountId))[SHAWSHANK.id]).toBe(IMDB_POSTER);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// With the real TheTVDB API, when TVDB_LIVE_API_KEY is set (it is not in CI).
describe.runIf(process.env.TVDB_LIVE_API_KEY)("TheTVDB posters, live", () => {
  beforeEach(() => {
    vi.stubEnv("TVDB_API_KEY", process.env.TVDB_LIVE_API_KEY ?? "");
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

    // An Account on IMDb keeps IMDb posters for the same Titles.
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

describe("saving the poster source", () => {
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
