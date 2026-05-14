import type { StremioMeta, WatchlistData } from "@stremlist/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../index.js";
import type * as ImdbScraper from "../services/imdb-scraper";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});

vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

// Stub the IMDb scraper so we control the meta set the catalog returns. We
// preserve the sort behavior (added_at, title, random etc.) by importing the
// real module's helpers and applying the same sortOptions to a fixture.
vi.mock("../services/imdb-scraper", async () => {
  const actual = await vi.importActual<typeof ImdbScraper>(
    "../services/imdb-scraper",
  );
  return {
    ...actual,
    fetchWatchlist: vi.fn(),
    fetchList: vi.fn(),
  };
});

import { fetchList, fetchWatchlist } from "../services/imdb-scraper";
import { seededShuffle } from "../utils";
import { db } from "./helpers/mock-supabase.js";

const OWNER = "ur12345678";
const WATCHLIST_ID = "11111111-1111-4111-8111-111111111111";

function makeMeta(id: string, type: "movie" | "series" = "movie"): StremioMeta {
  return {
    id,
    name: `Title ${id}`,
    poster: null,
    posterShape: "poster",
    type,
    genres: [],
    description: "",
  };
}

function makeMetas(
  count: number,
  type: "movie" | "series" = "movie",
): StremioMeta[] {
  return Array.from({ length: count }, (_, i) =>
    makeMeta(`tt${i.toString().padStart(7, "0")}`, type),
  );
}

function seedUserAndWatchlist(sortOption = "added_at-asc") {
  db.getTable("users").push({
    imdb_user_id: OWNER,
    is_active: true,
    created_at: new Date().toISOString(),
    last_fetched_at: new Date().toISOString(),
    rpdb_api_key: null,
    last_cache_served_at: null,
  });
  db.getTable("user_watchlists").push({
    id: WATCHLIST_ID,
    owner_user_id: OWNER,
    imdb_user_id: OWNER,
    catalog_title: "Test",
    sort_option: sortOption,
    position: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function catalogId(type: "movie" | "series") {
  return `wl-${WATCHLIST_ID}-${type}`;
}

async function fetchPage(
  type: "movie" | "series",
  extra?: string,
): Promise<StremioMeta[]> {
  const path = extra
    ? `/${OWNER}/catalog/${type}/${catalogId(type)}/${extra}.json`
    : `/${OWNER}/catalog/${type}/${catalogId(type)}.json`;
  const res = await app.request(path);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { metas: StremioMeta[] };
  return body.metas;
}

describe("catalog pagination via Stremio `skip`", () => {
  beforeEach(() => {
    db.reset();
    vi.mocked(fetchWatchlist).mockReset();
    vi.mocked(fetchList).mockReset();
  });

  describe("slice math for a 137-item list", () => {
    beforeEach(() => {
      seedUserAndWatchlist();
      const data: WatchlistData = { metas: makeMetas(137, "movie") };
      vi.mocked(fetchWatchlist).mockResolvedValue(data);
    });

    it("returns 100 items on page 1 (no extras)", async () => {
      const metas = await fetchPage("movie");
      expect(metas).toHaveLength(100);
      expect(metas[0].id).toBe("tt0000000");
      expect(metas[99].id).toBe("tt0000099");
    });

    it("returns 100 items on page 1 (explicit skip=0)", async () => {
      const metas = await fetchPage("movie", "skip=0");
      expect(metas).toHaveLength(100);
      expect(metas[0].id).toBe("tt0000000");
    });

    it("returns 37 items on page 2 (skip=100) — signals end of catalog", async () => {
      const metas = await fetchPage("movie", "skip=100");
      expect(metas).toHaveLength(37);
      expect(metas[0].id).toBe("tt0000100");
      expect(metas[36].id).toBe("tt0000136");
    });

    it("returns 0 items past the end (skip=200)", async () => {
      const metas = await fetchPage("movie", "skip=200");
      expect(metas).toEqual([]);
    });

    it("page1 ∪ page2 covers the full list with no duplicates", async () => {
      const page1 = await fetchPage("movie", "skip=0");
      const page2 = await fetchPage("movie", "skip=100");
      const ids = [...page1, ...page2].map((m) => m.id);
      expect(new Set(ids).size).toBe(137);
      expect(ids).toHaveLength(137);
    });
  });

  describe("invalid skip handling", () => {
    beforeEach(() => {
      seedUserAndWatchlist();
      vi.mocked(fetchWatchlist).mockResolvedValue({
        metas: makeMetas(137, "movie"),
      });
    });

    it("treats skip=-1 as 0", async () => {
      const metas = await fetchPage("movie", "skip=-1");
      expect(metas).toHaveLength(100);
      expect(metas[0].id).toBe("tt0000000");
    });

    it("treats skip=abc as 0", async () => {
      const metas = await fetchPage("movie", "skip=abc");
      expect(metas).toHaveLength(100);
      expect(metas[0].id).toBe("tt0000000");
    });

    it("ignores unknown extras alongside skip", async () => {
      const metas = await fetchPage("movie", "genre=Action&skip=100");
      expect(metas).toHaveLength(37);
      expect(metas[0].id).toBe("tt0000100");
    });
  });

  describe("random sort stability across pages", () => {
    beforeEach(() => {
      seedUserAndWatchlist("random");
    });

    it("page1 ∪ page2 equals the full shuffled set with no duplicates", async () => {
      // 137 metas; the mock returns them in the same order every call so the
      // pagination layer is the only thing that affects order.
      const items = makeMetas(137, "movie");
      const shuffled = seededShuffle(items);
      vi.mocked(fetchWatchlist).mockImplementation((_id, sortOptions) => {
        // Mimic the real fetchWatchlist: apply sortOptions to the items.
        if (sortOptions?.by === "random") {
          return Promise.resolve({ metas: shuffled });
        }
        return Promise.resolve({ metas: items });
      });

      const page1 = await fetchPage("movie", "skip=0");
      const page2 = await fetchPage("movie", "skip=100");

      const allIds = [...page1, ...page2].map((m) => m.id);
      expect(allIds).toHaveLength(137);
      expect(new Set(allIds).size).toBe(137);

      // Stable across requests: page 1 returns the same order each time.
      const page1Again = await fetchPage("movie", "skip=0");
      expect(page1Again.map((m) => m.id)).toEqual(page1.map((m) => m.id));
    });
  });

  describe("type filtering applies before skip", () => {
    beforeEach(() => {
      seedUserAndWatchlist();
      const metas = [
        ...makeMetas(120, "movie"),
        ...makeMetas(15, "series").map((m) => ({
          ...m,
          id: `tt${(2000000 + Number.parseInt(m.id.slice(2), 10)).toString()}`,
        })),
      ];
      vi.mocked(fetchWatchlist).mockResolvedValue({ metas });
    });

    it("paginates the movie subset independent of series count", async () => {
      const page1 = await fetchPage("movie", "skip=0");
      const page2 = await fetchPage("movie", "skip=100");
      expect(page1).toHaveLength(100);
      expect(page2).toHaveLength(20);
      expect(page1.every((m) => m.type === "movie")).toBe(true);
      expect(page2.every((m) => m.type === "movie")).toBe(true);
    });

    it("returns the series subset on the series catalog", async () => {
      const series = await fetchPage("series");
      expect(series).toHaveLength(15);
      expect(series.every((m) => m.type === "series")).toBe(true);
    });
  });
});
