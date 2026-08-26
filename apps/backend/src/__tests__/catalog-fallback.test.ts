import type { StremioMeta } from "@stremlist/shared";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../services/watchlist-cache", async () => {
  return await import("./helpers/mock-watchlist-cache.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import * as scraper from "../services/imdb-scraper";
import { db } from "./helpers/mock-supabase.js";
import { cache } from "./helpers/mock-watchlist-cache.js";

const OWNER = "ur216216210";
const UUID_1 = "6bde5e3d-617f-4912-950a-2f9acf815b7e";

function seedUser(imdbUserId: string) {
  db.getTable("users").push({
    imdb_user_id: imdbUserId,
    is_active: true,
    created_at: new Date().toISOString(),
    last_fetched_at: new Date().toISOString(),
    rpdb_api_key: null,
    last_cache_served_at: null,
  });
}

function seedWatchlist(id: string, sortOption = "added_at-asc") {
  db.getTable("user_watchlists").push({
    id,
    owner_user_id: OWNER,
    imdb_user_id: OWNER,
    catalog_title: "",
    sort_option: sortOption,
    position: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function seedCache(
  watchlistId: string,
  metas: StremioMeta[],
  cachedAt?: string,
) {
  if (metas.length === 0) return;
  cache.seed(watchlistId, metas, cachedAt ? new Date(cachedAt) : new Date());
}

const CACHED_MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};

interface CatalogMeta {
  id: string;
  type: string;
  name: string;
}
interface CatalogResponse {
  metas: CatalogMeta[];
}

// Movie catalog for a list with no cache row → the fetch failure has nothing to
// fall back on, so getWatchlistByConfig throws and the route's catch runs.
function requestMovieCatalog() {
  return app.request(`/${OWNER}/catalog/movie/wl-${UUID_1}-movie.json`);
}

beforeEach(() => {
  db.reset();
  cache.reset();
  vi.restoreAllMocks();
});

describe("catalog route degrades gracefully on fetch failure", () => {
  it("returns a 200 'private' card when the IMDb list is private and there is no cache", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestMovieCatalog();

    // Pre-fix this was a 500 that Stremio retry-stormed; now it's a friendly card.
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:private");
    expect(body.metas[0].type).toBe("movie");
    expect(body.metas[0].name.toLowerCase()).toContain("private");
  });

  it("returns a 200 'not found' card when the IMDb list does not exist", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_NOT_FOUND),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:not_found");
  });

  it("shows the private card even when an empty cache exists (does not serve the empty cache)", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    // Fresh but EMPTY cache — the real-world case (list cached empty, then went
    // private). Pre-fix this served the empty cache → silently-empty catalog.
    seedCache(UUID_1, []);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:private");
  });

  it("still serves a NON-empty stale cache as a graceful fallback when fetch fails", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    // Stale + non-empty: keep showing the user's last-known items rather than an
    // error — the fetch failure must not wipe a populated list.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    seedCache(UUID_1, [CACHED_MOVIE], twoDaysAgo.toISOString());
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogResponse;
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe(CACHED_MOVIE.id);
  });

  it("keeps the 500 for an unexpected/transient server error", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error("ECONNRESET while talking to IMDb"),
    );

    const res = await requestMovieCatalog();

    expect(res.status).toBe(500);
    expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
  });
});

describe("catalog pagination", () => {
  it("serves Stremio pages of at most 100 items using the skip extra", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(
      UUID_1,
      Array.from(
        { length: 205 },
        (_, index): StremioMeta => ({
          ...CACHED_MOVIE,
          id: `tt${String(index).padStart(7, "0")}`,
          name: `Movie ${index}`,
        }),
      ),
    );

    const first = await requestMovieCatalog();
    const second = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=100.json`,
    );
    const last = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=200.json`,
    );

    const firstBody = (await first.json()) as CatalogResponse;
    const secondBody = (await second.json()) as CatalogResponse;
    const lastBody = (await last.json()) as CatalogResponse;
    expect(firstBody.metas).toHaveLength(100);
    expect(secondBody.metas).toHaveLength(100);
    expect(lastBody.metas).toHaveLength(5);
    expect(firstBody.metas[0].id).toBe("tt0000000");
    expect(secondBody.metas[0].id).toBe("tt0000100");
    expect(lastBody.metas[0].id).toBe("tt0000200");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
  });

  it("keeps random pages stable and non-overlapping within a cache generation", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1, "random");
    seedCache(
      UUID_1,
      Array.from(
        { length: 205 },
        (_, index): StremioMeta => ({
          ...CACHED_MOVIE,
          id: `tt${String(index).padStart(7, "0")}`,
          name: `Movie ${index}`,
        }),
      ),
    );

    const first = await requestMovieCatalog();
    const second = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=100.json`,
    );
    const repeatedFirst = await requestMovieCatalog();

    const firstIds = ((await first.json()) as CatalogResponse).metas.map(
      (meta) => meta.id,
    );
    const secondIds = ((await second.json()) as CatalogResponse).metas.map(
      (meta) => meta.id,
    );
    const repeatedFirstIds = (
      (await repeatedFirst.json()) as CatalogResponse
    ).metas.map((meta) => meta.id);

    expect(repeatedFirstIds).toEqual(firstIds);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(200);
  });

  it("rejects an invalid skip value", async () => {
    seedUser(OWNER);
    seedWatchlist(UUID_1);
    seedCache(UUID_1, [CACHED_MOVIE]);

    const res = await app.request(
      `/${OWNER}/catalog/movie/wl-${UUID_1}-movie/skip=wat.json`,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as CatalogResponse).toEqual({ metas: [] });
  });
});
