import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/supabase", () => import("./helpers/mock-supabase.js"));
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));

import app from "../index.js";
import * as scraper from "../services/imdb-scraper";
import {
  movie,
  seedAccount,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const OWNER = "ur216216210";
const UUID_1 = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const CACHED_MOVIE = movie("tt0111161", { name: "The Shawshank Redemption" });

// Older than the default 60s refresh cooldown so a manual refresh is allowed.
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

let accountId = "";

function seedWatchlist(lastFetchedAt = TEN_MINUTES_AGO) {
  accountId = seedLegacyAccount(OWNER, { last_fetched_at: lastFetchedAt }).id;
  seedList(accountId, { id: UUID_1, source_ref: OWNER });
}

function serveWatchlist(metas: StremioMeta[]) {
  vi.spyOn(scraper, "fetchWatchlist").mockResolvedValue({
    metas,
    complete: true,
  });
}

async function refresh(key = OWNER) {
  const res = await app.request(`/${key}/refresh`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    lastFetchedAt: string;
    refreshed: number;
    failed: number;
    total: number;
    throttled?: boolean;
  };
}

function cachedIds() {
  return (cache.get(UUID_1)?.data.metas ?? []).map((meta) => meta.id).sort();
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  vi.restoreAllMocks();
});

describe("manual refresh reports honest success/failure counts", () => {
  it("counts a failed fetch as failed (not refreshed) even when a non-empty cache exists", async () => {
    seedWatchlist();
    // The catalog path would fall back to this cache, but a manual refresh
    // must report that the live fetch failed.
    cache.seed(UUID_1, [CACHED_MOVIE]);
    vi.spyOn(scraper, "fetchWatchlist").mockRejectedValue(
      new Error(scraper.ERROR_PRIVATE),
    );

    // No real fetch happened, so the cooldown timestamp is left untouched.
    expect(await refresh()).toMatchObject({
      refreshed: 0,
      failed: 1,
      total: 1,
      lastFetchedAt: TEN_MINUTES_AGO,
    });
  });

  it("reports a successful refresh and advances last_fetched_at", async () => {
    seedWatchlist();
    serveWatchlist([CACHED_MOVIE]);

    const body = await refresh();

    expect(body).toMatchObject({ refreshed: 1, failed: 0 });
    expect(body.lastFetchedAt).not.toBe(TEN_MINUTES_AGO);
  });

  it("replaces the previous cache with fresh non-duplicated items", async () => {
    seedWatchlist();
    // tt0000001 gets dropped, tt0111161 stays; older, so a refresh is required.
    cache.seed(
      UUID_1,
      [{ ...CACHED_MOVIE, id: "tt0000001" }, CACHED_MOVIE],
      new Date(Date.now() - 60 * 60 * 1000),
    );
    serveWatchlist([CACHED_MOVIE, movie("tt0000002", { name: "A New Film" })]);

    await refresh();

    expect(cachedIds()).toEqual(["tt0000002", "tt0111161"]);
  });

  it("de-duplicates repeated ids before caching", async () => {
    seedWatchlist();
    // IMDb lists aren't guaranteed sets: this one carries tt0111161 twice.
    serveWatchlist([
      CACHED_MOVIE,
      { ...CACHED_MOVIE, id: "tt0068646", name: "The Godfather" },
      { ...CACHED_MOVIE },
    ]);

    expect(await refresh()).toMatchObject({ refreshed: 1, failed: 0 });
    expect(cachedIds()).toEqual(["tt0068646", "tt0111161"]);
  });

  it("throttles a refresh that arrives within the cooldown window", async () => {
    seedWatchlist(new Date().toISOString());
    const spy = vi.spyOn(scraper, "fetchWatchlist");

    expect((await refresh()).throttled).toBe(true);
    // A throttled refresh must not touch IMDb at all.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("manual refresh through each kind of Addon URL", () => {
  it("refreshes through a private Account ID", async () => {
    const account = seedAccount({ last_fetched_at: TEN_MINUTES_AGO });
    seedList(account.id, { id: UUID_1, source_ref: OWNER });
    serveWatchlist([CACHED_MOVIE]);

    const body = await refresh(account.id);

    expect(body).toMatchObject({ refreshed: 1, failed: 0, total: 1 });
    expect(db.getTable("accounts")[0].last_fetched_at).toBe(body.lastFetchedAt);
  });

  it("skips Connection lists when the refresh comes through a Legacy alias", async () => {
    seedWatchlist();
    seedList(accountId, {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    serveWatchlist([CACHED_MOVIE]);

    expect(await refresh()).toMatchObject({
      refreshed: 1,
      failed: 0,
      total: 1,
    });
  });

  it("returns 404 for an unknown Addon URL", async () => {
    const res = await app.request(`/ur99999999/refresh`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
