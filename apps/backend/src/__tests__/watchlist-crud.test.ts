/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import { db } from "./helpers/mock-supabase.js";

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
    seedUser(OWNER);
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

    it("creates new watchlists with Supabase-generated UUIDs", async () => {
      const res = await postConfig(OWNER, {
        watchlists: [
          { imdbUserId: OWNER, sortOption: "added_at-desc" },
          { imdbUserId: OTHER_IMDB, sortOption: "year-asc" },
        ],
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.watchlists).toHaveLength(2);

      // IDs should be generated UUIDs
      for (const wl of data.watchlists) {
        expect(wl.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }

      expect(data.watchlists[0].imdbUserId).toBe(OWNER);
      expect(data.watchlists[1].imdbUserId).toBe(OTHER_IMDB);
    });

    it("preserves IDs when updating sort order", async () => {
      seedWatchlist({ id: UUID_1, sortOption: "added_at-asc" });

      const res = await postConfig(OWNER, {
        watchlists: [{ id: UUID_1, imdbUserId: OWNER, sortOption: "year-asc" }],
      });

      const data = await res.json();
      expect(data.watchlists).toHaveLength(1);
      expect(data.watchlists[0].id).toBe(UUID_1);
      expect(data.watchlists[0].sortOption).toBe("year-asc");
    });

    it("preserves IDs when updating catalog title", async () => {
      seedWatchlist({ id: UUID_1, catalogTitle: "Old Title" });

      const res = await postConfig(OWNER, {
        watchlists: [
          {
            id: UUID_1,
            imdbUserId: OWNER,
            catalogTitle: "New Title",
            sortOption: "added_at-asc",
          },
        ],
      });

      const data = await res.json();
      expect(data.watchlists[0].id).toBe(UUID_1);
      expect(data.watchlists[0].catalogTitle).toBe("New Title");
    });

    it("deletes removed watchlists", async () => {
      seedWatchlist({ id: UUID_1, position: 0 });
      seedWatchlist({
        id: UUID_2,
        imdbUserId: OTHER_IMDB,
        position: 1,
      });

      // Save with only the first watchlist → second should be deleted
      const res = await postConfig(OWNER, {
        watchlists: [
          { id: UUID_1, imdbUserId: OWNER, sortOption: "added_at-asc" },
        ],
      });

      const data = await res.json();
      expect(data.watchlists).toHaveLength(1);
      expect(data.watchlists[0].id).toBe(UUID_1);

      // Verify DB state
      const rows = db.getTable("user_watchlists");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(UUID_1);
    });

    it("can add a new watchlist alongside existing ones", async () => {
      seedWatchlist({ id: UUID_1, position: 0 });

      const res = await postConfig(OWNER, {
        watchlists: [
          { id: UUID_1, imdbUserId: OWNER, sortOption: "added_at-asc" },
          { imdbUserId: OTHER_IMDB, sortOption: "year-desc" },
        ],
      });

      const data = await res.json();
      expect(data.watchlists).toHaveLength(2);
      expect(data.watchlists[0].id).toBe(UUID_1);

      // New watchlist gets a generated UUID
      const newId = data.watchlists[1].id;
      expect(newId).toBeDefined();
      expect(newId).not.toBe(UUID_1);
      expect(data.watchlists[1].imdbUserId).toBe(OTHER_IMDB);
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

  // ---- The exact bug scenario ----

  describe("ID stability across saves (regression)", () => {
    it("IDs returned from first save are stable on subsequent saves", async () => {
      // Step 1: create two new watchlists (no IDs)
      const res1 = await postConfig(OWNER, {
        watchlists: [
          { imdbUserId: OWNER, sortOption: "added_at-asc" },
          { imdbUserId: OTHER_IMDB, sortOption: "added_at-asc" },
        ],
      });

      const data1 = await res1.json();
      expect(data1.watchlists).toHaveLength(2);
      const id1 = data1.watchlists[0].id;
      const id2 = data1.watchlists[1].id;

      // Step 2: re-save with IDs from step 1, changing sort order
      const res2 = await postConfig(OWNER, {
        watchlists: [
          { id: id1, imdbUserId: OWNER, sortOption: "year-asc" },
          { id: id2, imdbUserId: OTHER_IMDB, sortOption: "year-asc" },
        ],
      });

      const data2 = await res2.json();
      expect(data2.watchlists[0].id).toBe(id1);
      expect(data2.watchlists[1].id).toBe(id2);
      expect(data2.watchlists[0].sortOption).toBe("year-asc");
      expect(data2.watchlists[1].sortOption).toBe("year-asc");

      // Step 3: save a third time — IDs should still be the same
      const res3 = await postConfig(OWNER, {
        watchlists: [
          { id: id1, imdbUserId: OWNER, sortOption: "rating-desc" },
          { id: id2, imdbUserId: OTHER_IMDB, sortOption: "rating-desc" },
        ],
      });

      const data3 = await res3.json();
      expect(data3.watchlists[0].id).toBe(id1);
      expect(data3.watchlists[1].id).toBe(id2);
    });

    it("saving without IDs replaces all watchlists with fresh ones", async () => {
      // Create initial watchlists
      const res1 = await postConfig(OWNER, {
        watchlists: [
          { imdbUserId: OWNER, sortOption: "added_at-asc" },
          { imdbUserId: OTHER_IMDB, sortOption: "added_at-asc" },
        ],
      });
      const data1 = await res1.json();
      const oldId1 = data1.watchlists[0].id;
      const oldId2 = data1.watchlists[1].id;

      // Re-save WITHOUT IDs → should create new rows, delete old ones
      const res2 = await postConfig(OWNER, {
        watchlists: [
          { imdbUserId: OWNER, sortOption: "year-asc" },
          { imdbUserId: OTHER_IMDB, sortOption: "year-asc" },
        ],
      });

      const data2 = await res2.json();
      expect(data2.watchlists).toHaveLength(2);
      expect(data2.watchlists[0].id).not.toBe(oldId1);
      expect(data2.watchlists[1].id).not.toBe(oldId2);

      // DB should only have 2 rows (old ones deleted)
      const rows = db.getTable("user_watchlists");
      expect(rows).toHaveLength(2);
    });
  });

  // ---- RPDB API key ----

  describe("RPDB API key", () => {
    it("saves and returns RPDB API key", async () => {
      const res = await postConfig(OWNER, {
        rpdbApiKey: "test-rpdb-key",
        watchlists: [{ imdbUserId: OWNER, sortOption: "added_at-asc" }],
      });
      expect(res.status).toBe(200);

      const config = await getConfig(OWNER);
      const json = await config.json();
      expect(json.rpdbApiKey).toBe("test-rpdb-key");
    });

    it("clears RPDB API key when empty string is sent", async () => {
      // Set a key first
      const users = db.getTable("users");
      users[0].rpdb_api_key = "existing-key";

      await postConfig(OWNER, {
        rpdbApiKey: "",
        watchlists: [{ imdbUserId: OWNER, sortOption: "added_at-asc" }],
      });

      const config = await getConfig(OWNER);
      const json = await config.json();
      expect(json.rpdbApiKey).toBeNull();
    });
  });
});
