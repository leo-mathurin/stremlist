import type { StremioMeta } from "@stremlist/shared";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import * as scraper from "../services/imdb-scraper";
import { db } from "./helpers/mock-supabase.js";

const OWNER = "ur216216210";
const UUID_1 = "6bde5e3d-617f-4912-950a-2f9acf815b7e";

// Older than the default 60s refresh cooldown so a manual refresh is allowed.
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

function seedUser(lastFetchedAt: string) {
  db.getTable("users").push({
    imdb_user_id: OWNER,
    is_active: true,
    created_at: new Date().toISOString(),
    last_fetched_at: lastFetchedAt,
    rpdb_api_key: null,
    last_cache_served_at: null,
  });
}

function seedWatchlist(id: string) {
  db.getTable("user_watchlists").push({
    id,
    owner_user_id: OWNER,
    imdb_user_id: OWNER,
    catalog_title: "",
    sort_option: "added_at-asc",
    position: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function seedCache(watchlistId: string, metas: { id: string; type: string }[]) {
  const at = new Date().toISOString();
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

const CACHED_MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};

interface RefreshResponse {
  ok: boolean;
  lastFetchedAt: string;
  refreshed: number;
  failed: number;
  total: number;
  throttled?: boolean;
  cooldownSeconds: number;
}

function requestRefresh() {
  return app.request(`/${OWNER}/refresh`, { method: "POST" });
}

beforeEach(() => {
  db.reset();
  vi.restoreAllMocks();
});

describe("manual refresh reports honest success/failure counts", () => {
  it("counts a failed fetch as failed (not refreshed) even when a non-empty cache exists", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    // A populated cache exists: the catalog path would gracefully fall back to
    // it, but a manual refresh must report that the live fetch failed rather
    // than masking it as a successful refresh of stale data.
    seedCache(UUID_1, [CACHED_MOVIE]);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    const res = await requestRefresh();

    expect(res.status).toBe(200);
    const body = (await res.json()) as RefreshResponse;
    expect(body.refreshed).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.total).toBe(1);
    // No real fetch happened, so the cooldown timestamp must be left untouched.
    expect(body.lastFetchedAt).toBe(TEN_MINUTES_AGO);
  });

  it("reports a successful refresh and advances last_fetched_at", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    vi.spyOn(scraper, "fetchWatchlist").mockResolvedValue({
      metas: [CACHED_MOVIE],
    });

    const res = await requestRefresh();

    expect(res.status).toBe(200);
    const body = (await res.json()) as RefreshResponse;
    expect(body.refreshed).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.lastFetchedAt).not.toBe(TEN_MINUTES_AGO);
  });

  it("prunes the previous generation, leaving only fresh non-duplicated rows", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    // Previous generation: an item that gets dropped (OLD) and one that stays
    // (SHARED). Seed them with an older timestamp so the prune sees them as stale.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.getTable("watchlist_cache_items").push(
      {
        watchlist_id: UUID_1,
        item_id: "tt0000001",
        type: "movie",
        position: 0,
        data: { id: "tt0000001", type: "movie" },
        cached_at: anHourAgo,
      },
      {
        watchlist_id: UUID_1,
        item_id: "tt0111161",
        type: "movie",
        position: 1,
        data: { id: "tt0111161", type: "movie" },
        cached_at: anHourAgo,
      },
    );
    // Fresh fetch keeps SHARED (tt0111161) and adds NEW (tt0000002); OLD is gone.
    const NEW: StremioMeta = {
      id: "tt0000002",
      type: "movie",
      name: "A New Film",
      poster: null,
      posterShape: "poster",
      genres: [],
      description: "",
    };
    vi.spyOn(scraper, "fetchWatchlist").mockResolvedValue({
      metas: [CACHED_MOVIE, NEW],
    });

    const res = await requestRefresh();

    expect(res.status).toBe(200);
    const rows = db
      .getTable("watchlist_cache_items")
      .filter((r) => r.watchlist_id === UUID_1);
    const ids = rows.map((r) => r.item_id).sort();
    // OLD dropped, SHARED kept once (not duplicated), NEW added.
    expect(ids).toEqual(["tt0000002", "tt0111161"]);
  });

  it("de-duplicates repeated ids before caching (no ON CONFLICT failure)", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    // IMDb lists aren't guaranteed sets: this one carries tt0111161 twice. The
    // cache write must dedupe, otherwise the upsert fails with
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const GODFATHER: StremioMeta = {
      ...CACHED_MOVIE,
      id: "tt0068646",
      name: "The Godfather",
    };
    vi.spyOn(scraper, "fetchWatchlist").mockResolvedValue({
      metas: [CACHED_MOVIE, GODFATHER, { ...CACHED_MOVIE }],
    });

    const res = await requestRefresh();

    expect(res.status).toBe(200);
    const body = (await res.json()) as RefreshResponse;
    expect(body.refreshed).toBe(1);
    expect(body.failed).toBe(0);
    // tt0111161 stored exactly once (first occurrence kept), alongside the other.
    const ids = db
      .getTable("watchlist_cache_items")
      .filter((r) => r.watchlist_id === UUID_1)
      .map((r) => r.item_id)
      .sort();
    expect(ids).toEqual(["tt0068646", "tt0111161"]);
  });

  it("throttles a refresh that arrives within the cooldown window", async () => {
    seedUser(new Date().toISOString());
    seedWatchlist(UUID_1);
    const spy = vi.spyOn(scraper, "fetchWatchlist");

    const res = await requestRefresh();

    expect(res.status).toBe(200);
    const body = (await res.json()) as RefreshResponse;
    expect(body.throttled).toBe(true);
    // A throttled refresh must not touch IMDb at all.
    expect(spy).not.toHaveBeenCalled();
  });
});
