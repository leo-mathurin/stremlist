import type {
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

vi.mock("../lib/supabase", () => import("./helpers/mock-supabase.js"));
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));

import * as listsSvc from "../services/lists";
import {
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const OWNER = "ur88409068";
const UUID_1 = "11111111-1111-4111-8111-111111111111";
const SHAWSHANK = movie("tt0111161", {
  name: "The Shawshank Redemption",
  poster: "https://imdb.example/shawshank.jpg",
});
const BREAKING_BAD: StremioMeta = {
  ...SHAWSHANK,
  id: "tt0903747",
  type: "series",
  name: "Breaking Bad",
};

let accountId = "";

function seedUser(rpdbApiKey: string | null = null) {
  accountId = seedLegacyAccount(OWNER, { rpdb_api_key: rpdbApiKey }).id;
}

function seedWatchlist(metas?: StremioMeta[], cachedAt?: Date) {
  seedList(accountId, {
    id: UUID_1,
    source_ref: OWNER,
    sort_option: "added_at-desc",
  });
  if (metas) cache.seed(UUID_1, metas, cachedAt);
}

async function meta(key = OWNER, path = "movie/tt0111161") {
  const res = await app.request(`/${key}/meta/${path}.json`);
  expect(res.status).toBe(200);
  return (await res.json()) as { meta: Record<string, unknown> | null };
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  vi.restoreAllMocks();
});

describe("meta route serves from cache only", () => {
  it("declines cached series without accessing the cache so clients try an episode provider", async () => {
    seedUser();
    seedWatchlist([BREAKING_BAD]);
    const lookup = vi.spyOn(listsSvc, "findMetaInAccountCache");

    expect(await meta(OWNER, `series/${BREAKING_BAD.id}`)).toEqual({
      meta: null,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["/manifest.json", `/${OWNER}/manifest.json`])(
    "%s advertises movie metadata and keeps both catalog types",
    async (path) => {
      seedUser();
      seedWatchlist();

      const res = await app.request(path);
      const manifest = (await res.json()) as StremioManifest;

      expect(res.status).toBe(200);
      expect(manifest.resources).toEqual([
        "catalog",
        { name: "meta", types: ["movie"], idPrefixes: ["tt"] },
      ]);
      expect(manifest.types).toEqual(["movie", "series"]);
      expect(manifest.catalogs.map((catalog) => catalog.type)).toEqual([
        "movie",
        "series",
      ]);
    },
  );

  it("keeps cached series available in the series catalog", async () => {
    seedUser();
    seedWatchlist([SHAWSHANK, BREAKING_BAD]);

    const res = await app.request(
      `/${OWNER}/catalog/series/wl-${UUID_1}-series.json`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metas: [BREAKING_BAD] });
  });

  // Cached two days ago is far past the 30min refresh TTL: the catalog path
  // would re-scrape, the meta path still serves from cache with no fetch.
  it.each([
    ["a cached item, with its raw poster", "tt0111161", new Date(), SHAWSHANK],
    [
      "an item from a stale cache (TTL is ignored)",
      "tt0111161",
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      SHAWSHANK,
    ],
    [
      "{meta:null} for an item in no cached list",
      "tt99999999",
      new Date(),
      null,
    ],
  ])(
    "returns %s, with no per-request List fan-out",
    async (_label, id, cachedAt, expected) => {
      const fanOut = vi.spyOn(listsSvc, "getListCatalog");
      seedUser();
      seedWatchlist([SHAWSHANK], cachedAt);

      expect(await meta(OWNER, `movie/${id}`)).toEqual({ meta: expected });
      expect(fanOut).not.toHaveBeenCalled();
    },
  );

  it("applies the user's RPDB key to the served meta poster", async () => {
    seedUser("secretkey");
    seedWatchlist([SHAWSHANK]);

    expect((await meta()).meta?.poster).toBe(
      "https://api.ratingposterdb.com/secretkey/imdb/poster-default/tt0111161.jpg?fallback=true",
    );
  });

  it("returns {meta:null} (not 500) for an Account with no Lists", async () => {
    seedUser();

    expect(await meta()).toEqual({ meta: null });
  });
});

describe("meta route through each kind of Addon URL", () => {
  it("serves cached metadata through a private Account ID", async () => {
    const account = seedAccount();
    seedList(account.id, { id: UUID_1, source_ref: OWNER });
    cache.seed(UUID_1, [SHAWSHANK]);

    expect(await meta(account.id)).toEqual({ meta: SHAWSHANK });
  });

  it("returns {meta:null} for an unknown Addon URL", async () => {
    expect(await meta("ur10000001")).toEqual({ meta: null });
  });

  it("returns {meta:null} instead of a 500 when the database fails", async () => {
    seedUser();
    seedWatchlist([SHAWSHANK]);
    vi.spyOn(db, "getTable").mockImplementation(() => {
      throw new Error("database down");
    });

    expect(await meta()).toEqual({ meta: null });
  });
});

describe("meta route privacy", () => {
  it.each([
    ["does not reveal Connection lists through a Legacy alias", false, null],
    ["serves Connection lists to the private Addon URL", true, SHAWSHANK],
  ])("%s", async (_label, privateUrl, expected) => {
    const account = privateUrl ? seedAccount() : seedLegacyAccount(OWNER);
    if (privateUrl) seedConnection(account.id, "trakt");
    seedList(account.id, {
      id: UUID_1,
      provider: "trakt",
      source_ref: "me/history",
    });
    cache.seed(UUID_1, [SHAWSHANK]);

    expect(await meta(privateUrl ? account.id : OWNER)).toEqual({
      meta: expected,
    });
  });
});
