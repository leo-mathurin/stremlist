import { beforeEach, describe, expect, it, vi } from "vitest";

const watchlistMocks = vi.hoisted(() => ({
  getWatchlistByConfig: vi.fn(),
}));
const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("../watchlist", () => watchlistMocks);
vi.mock("../../lib/supabase", () => ({
  supabase: { rpc: supabaseMocks.rpc },
}));

import { prewarmWatchlists } from "../watchlist-prewarm";

describe("prewarmWatchlists", () => {
  beforeEach(() => {
    watchlistMocks.getWatchlistByConfig.mockReset();
    watchlistMocks.getWatchlistByConfig.mockResolvedValue({ metas: [] });
    supabaseMocks.rpc.mockReset();
    supabaseMocks.rpc.mockResolvedValue({ data: true, error: null });
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

  it("coalesces overlapping batches for the same owner", async () => {
    let finishFetch: (() => void) | undefined;
    watchlistMocks.getWatchlistByConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetch = () => {
            resolve({ metas: [] });
          };
        }),
    );
    const watchlists = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        imdbUserId: "ur12345678",
        catalogTitle: "Mine",
        sortOption: "added_at-asc",
        displayMode: "split" as const,
        position: 0,
      },
    ];

    const first = prewarmWatchlists("ur12345678", watchlists);
    const second = prewarmWatchlists("ur12345678", watchlists);

    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledOnce();
    });
    finishFetch?.();
    await Promise.all([first, second]);
  });

  it("runs at most two prewarms concurrently", async () => {
    const finishFetches: (() => void)[] = [];
    watchlistMocks.getWatchlistByConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetches.push(() => {
            resolve({ metas: [] });
          });
        }),
    );
    const watchlists = Array.from({ length: 3 }, (_, index) => ({
      id: `${index + 1}1111111-1111-4111-8111-111111111111`,
      imdbUserId: `ur1234567${index}`,
      catalogTitle: String(index),
      sortOption: "added_at-asc",
      displayMode: "split" as const,
      position: index,
    }));

    const batch = prewarmWatchlists("ur12345678", watchlists);

    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(2);
    });
    finishFetches[0]();
    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(3);
    });
    finishFetches.slice(1).forEach((finish) => {
      finish();
    });
    await batch;
  });

  it("queues the latest changed watchlist set behind the active batch", async () => {
    const finishFetches: (() => void)[] = [];
    watchlistMocks.getWatchlistByConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetches.push(() => {
            resolve({ metas: [] });
          });
        }),
    );
    const firstWatchlists = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        imdbUserId: "ur12345678",
        catalogTitle: "Mine",
        sortOption: "added_at-asc",
        displayMode: "split" as const,
        position: 0,
      },
    ];
    const changedWatchlists = [
      ...firstWatchlists,
      {
        id: "22222222-2222-4222-8222-222222222222",
        imdbUserId: "ur87654321",
        catalogTitle: "Friend",
        sortOption: "added_at-asc",
        displayMode: "split" as const,
        position: 1,
      },
    ];

    const first = prewarmWatchlists("ur12345678", firstWatchlists);
    const second = prewarmWatchlists("ur12345678", changedWatchlists);

    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledOnce();
    });
    finishFetches[0]();
    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(3);
    });
    finishFetches.slice(1).forEach((finish) => {
      finish();
    });
    await first;
  });

  it("skips the batch when another instance holds the database lease", async () => {
    supabaseMocks.rpc.mockResolvedValue({ data: false, error: null });

    await prewarmWatchlists("ur12345678", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        imdbUserId: "ur12345678",
        catalogTitle: "Mine",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      },
    ]);

    expect(supabaseMocks.rpc).toHaveBeenCalledWith(
      "try_acquire_watchlist_prewarm_lease",
      {
        p_owner_user_id: "ur12345678",
        p_lease_seconds: 600,
      },
    );
    expect(watchlistMocks.getWatchlistByConfig).not.toHaveBeenCalled();
  });

  it("fails closed when the database lease cannot be checked", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    supabaseMocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });

    await prewarmWatchlists("ur12345678", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        imdbUserId: "ur12345678",
        catalogTitle: "Mine",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      },
    ]);

    expect(watchlistMocks.getWatchlistByConfig).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Failed to acquire prewarm lease for ur12345678:",
      expect.objectContaining({ message: "database unavailable" }),
    );
  });
});
