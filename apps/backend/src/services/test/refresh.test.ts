import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import app from "../../index.js";
import {
  movie,
  seedAccount,
  seedLegacyAccount,
  seedList,
} from "../../test/helpers/account.fixture.js";
import { cache } from "../../test/helpers/mock-list-cache.js";
import { db, resetRpc } from "../../test/helpers/mock-supabase.js";
import { readJson, refreshBody } from "../../test/helpers/json.js";
import { FakeImdb } from "../../test/helpers/imdb.test-utils.js";
import { useMswServer } from "../../test/helpers/msw.test-utils.js";

vi.mock(
  "../../lib/supabase",
  () => import("../../test/helpers/mock-supabase.js"),
);
vi.mock("../list-cache", () => import("../../test/helpers/mock-list-cache.js"));
vi.mock("../../lib/resend", () => import("../../test/helpers/mock-resend"));

const OWNER = "ur216216210";
const UUID_1 = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const CACHED_MOVIE = movie("tt0111161", { name: "The Shawshank Redemption" });

const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

let accountId = "";

const imdb = new FakeImdb();
const server = useMswServer();

function seedWatchlist(lastFetchedAt = TEN_MINUTES_AGO) {
  accountId = seedLegacyAccount(OWNER, { last_fetched_at: lastFetchedAt }).id;
  seedList(accountId, { id: UUID_1, source_ref: OWNER });
}

function serveWatchlist(metas: StremioMeta[]) {
  imdb.watchlists.set(OWNER, metas);
}

async function refresh(key = OWNER) {
  const res = await app.request(`/${key}/refresh`, { method: "POST" });
  expect(res.status).toBe(200);
  return readJson(res, refreshBody);
}

function cachedIds() {
  return (cache.get(UUID_1)?.data.metas ?? []).map((meta) => meta.id).sort();
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  imdb.reset();
  server.use(imdb.handler);
});

describe("manual refresh reports honest success/failure counts", () => {
  it("counts a failed fetch as failed (not refreshed) even when a non-empty cache exists", async () => {
    seedWatchlist();
    cache.seed(UUID_1, [CACHED_MOVIE]);
    imdb.watchlists.set(OWNER, "private");

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

    expect((await refresh()).throttled).toBe(true);
    expect(imdb.requests).toEqual([]);
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
