import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import * as watchlistSvc from "../services/watchlist";
import { db } from "./helpers/mock-supabase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER = "ur88409068";
const UUID_1 = "11111111-1111-4111-8111-111111111111";

function seedUser(imdbUserId: string, rpdbApiKey: string | null = null) {
  db.getTable("users").push({
    imdb_user_id: imdbUserId,
    is_active: true,
    created_at: new Date().toISOString(),
    last_fetched_at: new Date().toISOString(),
    rpdb_api_key: rpdbApiKey,
    last_cache_served_at: null,
  });
}

function seedWatchlist(id: string, imdbUserId = OWNER) {
  db.getTable("user_watchlists").push({
    id,
    owner_user_id: OWNER,
    imdb_user_id: imdbUserId,
    catalog_title: "",
    sort_option: "added_at-desc",
    position: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function seedCache(
  watchlistId: string,
  metas: { id: string; type: string }[],
  cachedAt?: string,
) {
  const at = cachedAt ?? new Date().toISOString();
  metas.forEach((meta, i) => {
    db.getTable("watchlist_cache_items").push({
      watchlist_id: watchlistId,
      item_id: meta.id,
      type: meta.type,
      position: i,
      data: meta,
      cached_at: at,
    });
  });
}

const SHAWSHANK = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: "https://imdb.example/shawshank.jpg",
  posterShape: "poster",
  genres: [],
  description: "",
};

interface MetaResponse {
  meta: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  db.reset();
  vi.restoreAllMocks();
});

describe("meta route serves from cache only", () => {
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

    const res = await app.request(`/${OWNER}/meta/series/tt99999999.json`);

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

  it("does no per-request watchlist fan-out and never 500s", async () => {
    const spy = vi.spyOn(watchlistSvc, "getWatchlistByConfig");
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [SHAWSHANK]);

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns {meta:null} (not 500) for a user with no watchlists", async () => {
    seedUser(OWNER);

    const res = await app.request(`/${OWNER}/meta/movie/tt0111161.json`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MetaResponse).toEqual({ meta: null });
  });
});
