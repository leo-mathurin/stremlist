import type {
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import * as listsSvc from "../services/lists";
import {
  seedAccount,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER = "ur88409068";
const UUID_1 = "11111111-1111-4111-8111-111111111111";

let accountId = "";

function seedUser(imdbUserId: string, rpdbApiKey: string | null = null) {
  accountId = seedLegacyAccount(imdbUserId, { rpdb_api_key: rpdbApiKey }).id;
}

function seedWatchlist(id: string, imdbUserId = OWNER) {
  seedList(accountId, {
    id,
    source_ref: imdbUserId,
    sort_option: "added_at-desc",
  });
}

function seedCache(listId: string, metas: StremioMeta[], cachedAt?: string) {
  cache.seed(listId, metas, cachedAt ? new Date(cachedAt) : new Date());
}

const SHAWSHANK: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: "https://imdb.example/shawshank.jpg",
  posterShape: "poster",
  genres: [],
  description: "",
};

const BREAKING_BAD: StremioMeta = {
  ...SHAWSHANK,
  id: "tt0903747",
  type: "series",
  name: "Breaking Bad",
};

interface MetaResponse {
  meta: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  vi.restoreAllMocks();
});

describe("meta route serves from cache only", () => {
  it("declines cached series without accessing the cache so clients try an episode provider", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [BREAKING_BAD]);
    const lookup = vi.spyOn(listsSvc, "findMetaInAccountCache");

    const res = await app.request(
      `/${OWNER}/meta/series/${BREAKING_BAD.id}.json`,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: null });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["/manifest.json", `/${OWNER}/manifest.json`])(
    "%s advertises movie metadata and keeps both catalog types",
    async (path) => {
      seedUser(OWNER);
      seedWatchlist(UUID_1);

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
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK, BREAKING_BAD]);

    const res = await app.request(
      `/${OWNER}/catalog/series/wl-${UUID_1}-series.json`,
    );
    const body = (await res.json()) as { metas: StremioMeta[] };

    expect(res.status).toBe(200);
    expect(body.metas).toEqual([BREAKING_BAD]);
  });

  it("returns the cached meta for an item that is in the user's list", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK]);

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    // No RPDB key configured → the raw cached poster is preserved as-is.
    expect((await res.json()) as MetaResponse).toEqual({ meta: SHAWSHANK });
  });

  it("serves the item even from a stale cache (TTL is ignored for meta)", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    // Cached two days ago — far past the 30min refresh TTL. The catalog path
    // would re-scrape; the meta path must still serve from cache with no fetch.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    seedCache(UUID_1, [SHAWSHANK], twoDaysAgo.toISOString());

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: SHAWSHANK });
  });

  it("returns {meta:null} when the item is not in any cached list", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK]);

    const res = await app.request(`/${OWNER}/meta/movie/tt99999999.json`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: null });
  });

  it("applies the user's RPDB key to the served meta poster", async () => {
    seedUser(OWNER, "secretkey");
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK]);

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    const body = (await res.json()) as MetaResponse;
    expect(body.meta?.poster).toBe(
      "https://api.ratingposterdb.com/secretkey/imdb/poster-default/tt0111161.jpg?fallback=true",
    );
  });

  it("does no per-request List fan-out and never 500s", async () => {
    const spy = vi.spyOn(listsSvc, "getListCatalog");
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK]);

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns {meta:null} (not 500) for an Account with no Lists", async () => {
    seedUser(OWNER);

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: null });
  });
});

describe("meta route through each kind of Addon URL", () => {
  it("serves cached metadata through a private Account ID", async () => {
    const account = seedAccount();
    seedList(account.id, { id: UUID_1, source_ref: OWNER });
    seedCache(UUID_1, [SHAWSHANK]);

    const res = await app.request(`/${account.id}/meta/movie/tt0111161.json`);

    expect((await res.json()) as MetaResponse).toEqual({ meta: SHAWSHANK });
  });

  it("returns {meta:null} for an unknown Addon URL", async () => {
    const res = await app.request(`/ur10000001/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: null });
  });

  it("returns {meta:null} instead of a 500 when the database fails", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK]);
    vi.spyOn(db, "getTable").mockImplementation(() => {
      throw new Error("database down");
    });

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: null });
  });
});
