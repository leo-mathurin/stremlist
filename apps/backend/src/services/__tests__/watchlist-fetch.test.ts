import type { StremioMeta, WatchlistData } from "@stremlist/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scraperMocks = vi.hoisted(() => ({
  fetchChart: vi.fn(),
  fetchList: vi.fn(),
  fetchWatchlist: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  findCachedMeta: vi.fn(),
  getCachedWatchlist: vi.fn(),
  writeCachedWatchlist: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({ supabase: {} }));
vi.mock("../imdb-scraper", () => ({
  ...scraperMocks,
  buildPosterUrl: vi.fn((_id: string, poster: string | null) => poster),
  classifyWatchlistError: vi.fn(),
  isListId: vi.fn((id: string) => id.startsWith("ls")),
}));
vi.mock("../user", () => ({
  getUserRpdbApiKey: vi.fn(),
  getUserWatchlists: vi.fn(),
}));
vi.mock("../watchlist-cache", () => cacheMocks);

import { getWatchlistByConfig } from "../watchlist";

const MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};

describe("getWatchlistByConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheMocks.getCachedWatchlist.mockResolvedValue(null);
    cacheMocks.writeCachedWatchlist.mockResolvedValue(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("coalesces concurrent cache misses for the same watchlist source", async () => {
    const releaseFetches: ((data: WatchlistData) => void)[] = [];
    scraperMocks.fetchList.mockImplementation(
      () =>
        new Promise<WatchlistData>((resolve) => {
          releaseFetches.push(resolve);
        }),
    );

    const config = {
      ownerUserId: "ur12345678",
      watchlistId: "22222222-2222-4222-8222-222222222222",
      imdbUserId: "ls123456789",
      sortOption: "added_at-asc",
      skipUserTimestamp: true,
    };
    const first = getWatchlistByConfig(config);
    const second = getWatchlistByConfig(config);

    await vi.waitFor(() => {
      expect(cacheMocks.getCachedWatchlist).toHaveBeenCalledTimes(2);
    });
    releaseFetches.forEach((release) => {
      release({ metas: [MOVIE] });
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { metas: [MOVIE] },
      { metas: [MOVIE] },
    ]);
    expect(scraperMocks.fetchList).toHaveBeenCalledOnce();
    expect(cacheMocks.writeCachedWatchlist).toHaveBeenCalledOnce();
  });
});
