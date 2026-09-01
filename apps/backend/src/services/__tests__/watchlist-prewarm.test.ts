import { beforeEach, describe, expect, it, vi } from "vitest";

const watchlistMocks = vi.hoisted(() => ({
  getWatchlistByConfig: vi.fn(),
}));

vi.mock("../watchlist", () => watchlistMocks);

import { prewarmWatchlists } from "../watchlist-prewarm";

describe("prewarmWatchlists", () => {
  beforeEach(() => {
    watchlistMocks.getWatchlistByConfig.mockReset();
    watchlistMocks.getWatchlistByConfig.mockResolvedValue({ metas: [] });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("uses the cache-first fetch path for every saved watchlist", async () => {
    await prewarmWatchlists("ur12345678", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        imdbUserId: "ur12345678",
        catalogTitle: "Mine",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        imdbUserId: "ls123456789",
        catalogTitle: "List",
        sortOption: "year-desc",
        displayMode: "split",
        position: 1,
      },
    ]);

    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(2);
    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenNthCalledWith(1, {
      ownerUserId: "ur12345678",
      watchlistId: "11111111-1111-4111-8111-111111111111",
      imdbUserId: "ur12345678",
      sortOption: "added_at-asc",
      rpdbApiKey: null,
      skipUserTimestamp: true,
    });
    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenNthCalledWith(2, {
      ownerUserId: "ur12345678",
      watchlistId: "22222222-2222-4222-8222-222222222222",
      imdbUserId: "ls123456789",
      sortOption: "year-desc",
      rpdbApiKey: null,
      skipUserTimestamp: true,
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 2\/2 watchlists in \d+ms$/),
    );
  });

  it("continues the batch when one prewarm fails", async () => {
    watchlistMocks.getWatchlistByConfig.mockRejectedValueOnce(
      new Error("IMDb unavailable"),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      prewarmWatchlists("ur12345678", [
        {
          id: "11111111-1111-4111-8111-111111111111",
          imdbUserId: "ur12345678",
          catalogTitle: "",
          sortOption: "added_at-asc",
          displayMode: "split",
          position: 0,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          imdbUserId: "ls123456789",
          catalogTitle: "Still runs",
          sortOption: "added_at-asc",
          displayMode: "split",
          position: 1,
        },
      ]),
    ).resolves.toBeUndefined();

    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "Failed to prewarm watchlist 11111111-1111-4111-8111-111111111111:",
      expect.any(Error),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 1\/2 watchlists in \d+ms$/),
    );
  });
});
