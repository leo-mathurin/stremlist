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
import { localizeDescription } from "../../services/metadata";
import { resetTranslationMemory } from "../title-translations";
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
import {
  catalogMetasBody,
  configBody,
  createdAccountBody,
  metaBody,
  readJson,
} from "../../test/helpers/json.js";
import { cache } from "../../test/helpers/list-cache.test-utils.js";
import { db, resetRpc } from "../../test/helpers/mock-supabase.js";
import { useMswServer } from "../../test/helpers/msw.test-utils.js";
import { resetR2 } from "../../test/helpers/r2.test-utils.js";

const server = useMswServer();
useBackgroundTasks();
const imdb = new FakeImdb();

const LIST_ID = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const OTHER_LIST_ID = "0f4ef1b5-0a8c-4a4e-9f1e-3b2c1d0e9a87";

const DUNE = movie("tt15239678", {
  name: "Dune: Part Two",
  description:
    "Paul Atreides unites with Chani and the Fremen.\n\nMore on Trakt: https://trakt.tv/movies/dune-part-two",
});
const ALIEN = movie("tt0078748", {
  name: "Alien",
  description:
    "The crew of a commercial spacecraft encounters a deadly lifeform.",
});

let tmdbCalls: { id: string; language: string | null }[] = [];

function tmdbFind(status = 200) {
  server.use(
    http.get("https://api.themoviedb.org/3/find/:id", ({ params, request }) => {
      const id = String(params.id);
      const language = new URL(request.url).searchParams.get("language");
      tmdbCalls.push({ id, language });
      if (status !== 200) return new HttpResponse("down", { status });
      if (id === DUNE.id && language === "it-IT") {
        return HttpResponse.json({
          movie_results: [
            {
              title: "Dune - Parte due",
              overview: "Paul Atreides si unisce a Chani e ai Fremen.",
            },
          ],
          tv_results: [],
        });
      }
      return HttpResponse.json({ movie_results: [], tv_results: [] });
    }),
  );
}

function seedWithList(
  account: Parameters<typeof seedAccount>[0],
  listId = LIST_ID,
  metas: StremioMeta[] = [DUNE, ALIEN],
) {
  const { id } = seedAccount(account);
  seedList(id, { id: listId, source_ref: "ur12345678" });
  cache.seed(listId, metas);
  return id;
}

async function catalogMetas(accountId: string, listId = LIST_ID) {
  const res = await app.request(
    `/${accountId}/catalog/movie/wl-${listId}-movie.json`,
  );
  expect(res.status).toBe(200);
  const { metas } = await readJson(res, catalogMetasBody);
  return metas;
}

beforeEach(() => {
  tmdbCalls = [];
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  imdb.watchlists.set("ur12345678", [DUNE, ALIEN]);
  server.use(imdb.handler, cinemetaWithoutTitles);
  resetTranslationMemory();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("localizeDescription", () => {
  it("preserves New titles prefix and Provider link-back suffix", () => {
    expect(
      localizeDescription(
        "Detected by Stremlist on May 1 in Watchlist.\n\nEnglish plot.\n\nMore on Simkl: https://simkl.com/movies/1",
        "Trama italiana.",
      ),
    ).toBe(
      "Detected by Stremlist on May 1 in Watchlist.\n\nTrama italiana.\n\nMore on Simkl: https://simkl.com/movies/1",
    );
  });
});

describe("metadata language in Stremio responses", () => {
  it("keeps English metadata by default and never asks TMDB", async () => {
    tmdbFind();
    const accountId = seedWithList({});
    const metas = await catalogMetas(accountId);

    expect(metas[0]).toMatchObject({
      id: DUNE.id,
      name: DUNE.name,
      description: DUNE.description,
    });
    expect(tmdbCalls).toEqual([]);
  });

  it("localizes titles and plot summaries via TMDB, keeps link-back, and falls back to English", async () => {
    tmdbFind();
    const accountId = seedWithList({ metadata_language: "it-IT" });
    const metas = await catalogMetas(accountId);

    expect(metas[0]).toMatchObject({
      id: DUNE.id,
      name: "Dune - Parte due",
      description:
        "Paul Atreides si unisce a Chani e ai Fremen.\n\nMore on Trakt: https://trakt.tv/movies/dune-part-two",
    });
    expect(metas[1]).toMatchObject({
      id: ALIEN.id,
      name: ALIEN.name,
      description: ALIEN.description,
    });
    expect(
      db
        .getTable("title_translations")
        .map(({ language, imdb_id, title, description }) => ({
          language,
          imdb_id,
          title,
          description,
        })),
    ).toEqual(
      expect.arrayContaining([
        {
          language: "it-IT",
          imdb_id: DUNE.id,
          title: "Dune - Parte due",
          description: "Paul Atreides si unisce a Chani e ai Fremen.",
        },
        {
          language: "it-IT",
          imdb_id: ALIEN.id,
          title: null,
          description: null,
        },
      ]),
    );
  });

  it("reuses stored translations instead of asking TMDB again", async () => {
    tmdbFind();
    const accountId = seedWithList({ metadata_language: "it-IT" });
    await catalogMetas(accountId);
    expect(tmdbCalls).toHaveLength(2);

    resetTranslationMemory();
    const metas = await catalogMetas(accountId);
    expect(metas[0]?.name).toBe("Dune - Parte due");
    expect(tmdbCalls).toHaveLength(2);
  });

  it("keeps English metadata while TMDB fails, and stores nothing", async () => {
    vi.spyOn(console, "warn");
    tmdbFind(503);
    const accountId = seedWithList({ metadata_language: "it-IT" });

    const metas = await catalogMetas(accountId);
    expect(metas[0]?.name).toBe(DUNE.name);
    expect(db.getTable("title_translations")).toEqual([]);
    const calls = tmdbCalls.length;
    await catalogMetas(accountId);
    expect(tmdbCalls).toHaveLength(calls);
  });

  it("omits descriptions in catalog and returns null meta when set to Stremio's metadata", async () => {
    tmdbFind();
    const accountId = seedWithList({ metadata_language: "stremio" });

    const metas = await catalogMetas(accountId);
    expect(metas[0]?.name).toBe(DUNE.name);
    expect("description" in (metas[0] ?? {})).toBe(false);
    expect(tmdbCalls).toEqual([]);

    const metaRes = await app.request(
      `/${accountId}/meta/movie/${DUNE.id}.json`,
    );
    expect(await readJson(metaRes, metaBody)).toEqual({ meta: null });
  });

  it("localizes the meta route for a chosen language", async () => {
    tmdbFind();
    const accountId = seedWithList({ metadata_language: "it-IT" });

    const metaRes = await app.request(
      `/${accountId}/meta/movie/${DUNE.id}.json`,
    );
    const { meta } = await readJson(metaRes, metaBody);
    expect(meta).toMatchObject({
      id: DUNE.id,
      name: "Dune - Parte due",
      description:
        "Paul Atreides si unisce a Chani e ai Fremen.\n\nMore on Trakt: https://trakt.tv/movies/dune-part-two",
    });
  });

  it("isolates metadata language per Account", async () => {
    tmdbFind();
    const italianAccount = seedWithList({ metadata_language: "it-IT" });
    const englishAccount = seedWithList({}, OTHER_LIST_ID);

    expect((await catalogMetas(italianAccount))[0]?.name).toBe(
      "Dune - Parte due",
    );
    expect((await catalogMetas(englishAccount, OTHER_LIST_ID))[0]?.name).toBe(
      DUNE.name,
    );
  });
});

describe("saving the metadata language", () => {
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

  async function savedLanguage(accountId: string) {
    const res = await app.request(`/${accountId}/config`);
    return (await readJson(res, configBody)).metadataLanguage;
  }

  it("starts new Accounts on en-US", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [list] }),
    });
    const { accountId } = await readJson(res, createdAccountBody);
    expect(await savedLanguage(accountId)).toBe("en-US");
  });

  it("creates an Account with the chosen language", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [list], metadataLanguage: "it-IT" }),
    });
    const { accountId } = await readJson(res, createdAccountBody);
    expect(await savedLanguage(accountId)).toBe("it-IT");
  });

  it("saves changes and keeps the saved language when omitted", async () => {
    const { id } = seedAccount({});
    expect(await savedLanguage(id)).toBe("en-US");

    expect((await save(id, { metadataLanguage: "it-IT" })).status).toBe(200);
    expect(await savedLanguage(id)).toBe("it-IT");
    expect(db.getTable("accounts")[0].metadata_language).toBe("it-IT");

    expect((await save(id, { rpdbApiKey: "" })).status).toBe(200);
    expect(await savedLanguage(id)).toBe("it-IT");

    expect((await save(id, { metadataLanguage: "stremio" })).status).toBe(200);
    expect(await savedLanguage(id)).toBe("stremio");
  });

  it("refuses an unknown language", async () => {
    const { id } = seedAccount({});
    expect((await save(id, { metadataLanguage: "klingon" })).status).toBe(400);
    expect(await savedLanguage(id)).toBe("en-US");
  });
});
