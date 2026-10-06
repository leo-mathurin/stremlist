import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import * as scraper from "../services/imdb-scraper";
import {
  seedAccount,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const OWNER = "ur216216210";
const UUID_1 = "6bde5e3d-617f-4912-950a-2f9acf815b7e";

// Older than the default 60s refresh cooldown so a manual refresh is allowed.
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

let accountId = "";

function seedUser(lastFetchedAt: string) {
  accountId = seedLegacyAccount(OWNER, { last_fetched_at: lastFetchedAt }).id;
}

function seedWatchlist(id: string) {
  seedList(accountId, { id, source_ref: OWNER });
}

function seedCache(listId: string, metas: { id: string; type: string }[]) {
  cache.seed(listId, metas as StremioMeta[]);
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
  resetRpc();
  cache.reset();
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

  it("replaces the previous cache with fresh non-duplicated items", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    // Previous cache: an item that gets dropped (OLD) and one that stays
    // (SHARED). Seed them with an older timestamp so a refresh is required.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    cache.seed(
      UUID_1,
      [
        { ...CACHED_MOVIE, id: "tt0000001" },
        { ...CACHED_MOVIE, id: "tt0111161" },
      ],
      new Date(anHourAgo),
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
    const ids = (cache.get(UUID_1)?.data.metas ?? [])
      .map((meta) => meta.id)
      .sort();
    // OLD dropped, SHARED kept once (not duplicated), NEW added.
    expect(ids).toEqual(["tt0000002", "tt0111161"]);
  });

  it("de-duplicates repeated ids before caching", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    // IMDb lists aren't guaranteed sets: this one carries tt0111161 twice.
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
    const ids = (cache.get(UUID_1)?.data.metas ?? [])
      .map((meta) => meta.id)
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

describe("manual refresh through each kind of Addon URL", () => {
  it("refreshes through a private Account ID", async () => {
    const account = seedAccount({ last_fetched_at: TEN_MINUTES_AGO });
    seedList(account.id, { id: UUID_1, source_ref: OWNER });
    vi.spyOn(scraper, "fetchWatchlist").mockResolvedValue({
      metas: [CACHED_MOVIE],
    });

    const res = await app.request(`/${account.id}/refresh`, {
      method: "POST",
    });

    const body = (await res.json()) as RefreshResponse;
    expect(body).toMatchObject({ refreshed: 1, failed: 0, total: 1 });
    expect(db.getTable("accounts")[0].last_fetched_at).toBe(body.lastFetchedAt);
  });

  it("skips Connection lists when the refresh comes through a Legacy alias", async () => {
    seedUser(TEN_MINUTES_AGO);
    seedWatchlist(UUID_1);
    seedList(accountId, {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    vi.spyOn(scraper, "fetchWatchlist").mockResolvedValue({
      metas: [CACHED_MOVIE],
    });

    const body = (await (await requestRefresh()).json()) as RefreshResponse;

    expect(body).toMatchObject({ refreshed: 1, failed: 0, total: 1 });
  });

  it("returns 404 for an unknown Addon URL", async () => {
    const res = await app.request(`/ur99999999/refresh`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
