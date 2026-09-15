/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { Database, Tables } from "@stremlist/shared/database.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

type ReplaceConfig = Database["public"]["Functions"]["replace_user_config"];
const rpcMocks = vi.hoisted(() => ({
  rpc: vi.fn<
    (
      name: "replace_user_config",
      args: ReplaceConfig["Args"],
    ) => Promise<{
      data: ReplaceConfig["Returns"] | null;
      error: Error | null;
    }>
  >(),
}));

const backgroundMocks = vi.hoisted(() => ({
  scheduleBackgroundTask: vi.fn(),
}));
const prewarmMocks = vi.hoisted(() => ({
  prewarmWatchlists: vi.fn(),
}));

vi.mock("../lib/background", () => backgroundMocks);
vi.mock("../services/watchlist-prewarm", () => prewarmMocks);

vi.mock("../lib/supabase", async () => {
  const { supabase } = await import("./helpers/mock-supabase.js");
  return { supabase: { ...supabase, rpc: rpcMocks.rpc } };
});

vi.mock("../services/watchlist-cache", async () => {
  return await import("./helpers/mock-watchlist-cache.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import { db } from "./helpers/mock-supabase.js";
import { cache } from "./helpers/mock-watchlist-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER = "ur12345678";
const OTHER_IMDB = "ur87654321";

const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

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

function seedWatchlist(overrides: {
  id: string;
  ownerUserId?: string;
  imdbUserId?: string;
  catalogTitle?: string;
  sortOption?: string;
  position?: number;
}) {
  db.getTable("user_watchlists").push({
    id: overrides.id,
    owner_user_id: overrides.ownerUserId ?? OWNER,
    imdb_user_id: overrides.imdbUserId ?? OWNER,
    catalog_title: overrides.catalogTitle ?? "",
    sort_option: overrides.sortOption ?? "added_at-asc",
    position: overrides.position ?? 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function getConfig(userId: string) {
  return app.request(`/${userId}/config`);
}

function postConfig(
  userId: string,
  body: {
    rpdbApiKey?: string;
    watchlists: {
      id?: string;
      imdbUserId: string;
      catalogTitle?: string;
      sortOption: string;
      position?: number;
      catalogSettings?: CatalogSettings;
    }[];
  },
) {
  return app.request(`/${userId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Watchlist CRUD via API", () => {
  beforeEach(() => {
    db.reset();
    rpcMocks.rpc.mockReset();
    cache.reset();
    seedUser(OWNER);
    backgroundMocks.scheduleBackgroundTask.mockReset();
    prewarmMocks.prewarmWatchlists.mockReset();
    prewarmMocks.prewarmWatchlists.mockResolvedValue(undefined);
  });

  it.each([
    { minRating: 11 },
    { maxRuntime: -1 },
    { decade: 1995 },
    { genre: "" },
  ])("rejects invalid catalog settings %j", async (catalogSettings) => {
    seedWatchlist({ id: UUID_1 });
    const response = await postConfig(OWNER, {
      watchlists: [
        {
          id: UUID_1,
          imdbUserId: OWNER,
          sortOption: "title-asc",
          catalogSettings,
        },
      ],
    });
    expect(response.status).toBe(400);
  });

  // ---- GET /:userId/config ----

  describe("GET /:userId/config", () => {
    it("returns 404 for unknown user", async () => {
      const res = await getConfig("ur99999999");
      expect(res.status).toBe(404);
    });

    it("returns empty watchlists when none exist", async () => {
      const res = await getConfig(OWNER);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.watchlists).toEqual([]);
      expect(data.rpdbApiKey).toBeNull();
      expect(typeof data.lastFetchedAt).toBe("string");
    });

    it("returns existing watchlists with their IDs", async () => {
      seedWatchlist({ id: UUID_1, catalogTitle: "Movies" });
      seedWatchlist({
        id: UUID_2,
        imdbUserId: OTHER_IMDB,
        catalogTitle: "Friend",
        position: 1,
      });

      const res = await getConfig(OWNER);
      const data = await res.json();

      expect(data.watchlists).toHaveLength(2);
      expect(data.watchlists[0]).toMatchObject({
        id: UUID_1,
        imdbUserId: OWNER,
        catalogTitle: "Movies",
      });
      expect(data.watchlists[1]).toMatchObject({
        id: UUID_2,
        imdbUserId: OTHER_IMDB,
        catalogTitle: "Friend",
      });
    });

    it("returns watchlists sorted by position", async () => {
      seedWatchlist({ id: UUID_2, position: 1, catalogTitle: "Second" });
      seedWatchlist({ id: UUID_1, position: 0, catalogTitle: "First" });

      const data = await getConfig(OWNER);
      const json = await data.json();
      expect(json.watchlists[0].catalogTitle).toBe("First");
      expect(json.watchlists[1].catalogTitle).toBe("Second");
    });
  });

  // ---- POST /:userId/config ----

  describe("POST /:userId/config", () => {
    it("returns 404 for unknown user", async () => {
      const res = await postConfig("ur99999999", {
        watchlists: [{ imdbUserId: "ur99999999", sortOption: "added_at-asc" }],
      });
      expect(res.status).toBe(404);
    });

    it("rejects duplicate IMDb user IDs", async () => {
      const res = await postConfig(OWNER, {
        watchlists: [
          { imdbUserId: OWNER, sortOption: "added_at-asc" },
          { imdbUserId: OWNER, sortOption: "year-asc" },
        ],
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("unique");
      expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
    });

    it("rejects empty watchlist array", async () => {
      const res = await postConfig(OWNER, { watchlists: [] });
      expect(res.status).toBe(400);
    });

    it("rejects invalid IMDb user ID format", async () => {
      const res = await postConfig(OWNER, {
        watchlists: [{ imdbUserId: "invalid", sortOption: "added_at-asc" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid sort option", async () => {
      const res = await postConfig(OWNER, {
        watchlists: [{ imdbUserId: OWNER, sortOption: "invalid-sort" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects more than 10 watchlists", async () => {
      const watchlists = Array.from({ length: 11 }, (_, i) => ({
        imdbUserId: `ur${String(10000000 + i)}`,
        sortOption: "added_at-asc",
      }));
      const res = await postConfig(OWNER, { watchlists });
      expect(res.status).toBe(400);
    });
  });

  describe("configuration RPC boundary", () => {
    const savedRow: Tables<"user_watchlists"> = {
      id: UUID_1,
      owner_user_id: OWNER,
      imdb_user_id: OWNER,
      catalog_title: "Saved title",
      sort_option: "rating-desc",
      display_mode: "split",
      position: 0,
      catalog_settings: { minRating: 8 },
      created_at: "2026-09-15T00:00:00Z",
      updated_at: "2026-09-15T00:00:00Z",
    };

    beforeEach(() => {
      rpcMocks.rpc.mockResolvedValue({
        data: [{ deleted_ids: [], watchlists: [savedRow] }],
        error: null,
      });
    });

    it("sends normalized rows in one RPC and returns/prewarms the committed rows", async () => {
      const response = await postConfig(OWNER, {
        rpdbApiKey: "  secret-key  ",
        watchlists: [
          {
            id: UUID_1,
            imdbUserId: OWNER,
            catalogTitle: "Updated",
            sortOption: "title-asc",
            position: 7,
          },
          { imdbUserId: OTHER_IMDB, sortOption: "year-desc" },
        ],
      });
      expect(response.status).toBe(200);
      expect(rpcMocks.rpc).toHaveBeenCalledExactlyOnceWith(
        "replace_user_config",
        {
          p_owner_user_id: OWNER,
          p_rpdb_api_key: "secret-key",
          p_watchlists: [
            {
              id: UUID_1,
              imdb_user_id: OWNER,
              catalog_title: "Updated",
              sort_option: "title-asc",
              display_mode: "split",
              position: 0,
            },
            {
              imdb_user_id: OTHER_IMDB,
              catalog_title: "2",
              sort_option: "year-desc",
              display_mode: "split",
              position: 1,
            },
          ],
        },
      );
      const expected = [
        {
          id: UUID_1,
          imdbUserId: OWNER,
          catalogTitle: "Saved title",
          sortOption: "rating-desc",
          displayMode: "split",
          position: 0,
          catalogSettings: { minRating: 8 },
        },
      ];
      expect(await response.json()).toEqual({
        ok: true,
        watchlists: expected.map((row) => ({ ...row, availableGenres: [] })),
      });
      expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();
      const task = backgroundMocks.scheduleBackgroundTask.mock
        .calls[0][0] as () => Promise<void>;
      await task();
      expect(prewarmMocks.prewarmWatchlists).toHaveBeenCalledExactlyOnceWith(
        OWNER,
        expected,
      );
    });

    it("keeps omitted settings distinct from an explicit clear in the RPC payload", async () => {
      await postConfig(OWNER, {
        watchlists: [
          { id: UUID_1, imdbUserId: OWNER, sortOption: "title-asc" },
          {
            id: UUID_2,
            imdbUserId: OTHER_IMDB,
            sortOption: "title-desc",
            catalogSettings: {},
          },
        ],
      });
      expect(rpcMocks.rpc.mock.calls[0][1].p_watchlists).toEqual([
        {
          id: UUID_1,
          imdb_user_id: OWNER,
          catalog_title: "1",
          sort_option: "title-asc",
          display_mode: "split",
          position: 0,
        },
        {
          id: UUID_2,
          imdb_user_id: OTHER_IMDB,
          catalog_title: "2",
          sort_option: "title-desc",
          display_mode: "split",
          position: 1,
          catalog_settings: {},
        },
      ]);
    });

    it("passes combined filters, custom values and presets through unchanged", async () => {
      const catalogSettings: CatalogSettings = {
        genre: "Comedy",
        decade: 2090,
        maxRuntime: 95,
        minRating: 7.2,
        presets: ["short", "rated", "shuffle"],
      };
      const response = await postConfig(OWNER, {
        watchlists: [
          { imdbUserId: OWNER, sortOption: "title-asc", catalogSettings },
        ],
      });
      expect(response.status).toBe(200);
      expect(rpcMocks.rpc.mock.calls[0][1].p_watchlists).toEqual([
        {
          imdb_user_id: OWNER,
          catalog_title: "",
          sort_option: "title-asc",
          display_mode: "split",
          position: 0,
          catalog_settings: catalogSettings,
        },
      ]);
    });

    it.each([undefined, "", "   "])(
      "normalizes an empty RPDB key (%j) to null",
      async (rpdbApiKey) => {
        await postConfig(OWNER, {
          rpdbApiKey,
          watchlists: [{ imdbUserId: OWNER, sortOption: "added_at-asc" }],
        });
        expect(rpcMocks.rpc.mock.calls[0][1].p_rpdb_api_key).toBeNull();
      },
    );

    it("deletes only the cache IDs returned by the committed transaction", async () => {
      cache.seed(UUID_1, []);
      cache.seed(UUID_2, []);
      rpcMocks.rpc.mockResolvedValueOnce({
        data: [{ deleted_ids: [UUID_2], watchlists: [savedRow] }],
        error: null,
      });
      const response = await postConfig(OWNER, {
        watchlists: [
          { id: UUID_1, imdbUserId: OWNER, sortOption: "title-asc" },
        ],
      });
      expect(response.status).toBe(200);
      expect(cache.get(UUID_1)).not.toBeNull();
      expect(cache.get(UUID_2)).toBeNull();
    });

    it("keeps caches and skips prewarming when the RPC fails", async () => {
      cache.seed(UUID_2, []);
      rpcMocks.rpc.mockResolvedValueOnce({
        data: null,
        error: new Error("Transaction rolled back"),
      });
      const response = await postConfig(OWNER, {
        rpdbApiKey: "new-key",
        watchlists: [
          { id: UUID_1, imdbUserId: OWNER, sortOption: "title-asc" },
        ],
      });
      expect(response.status).toBe(500);
      expect(cache.get(UUID_2)).not.toBeNull();
      expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
    });
  });
});
