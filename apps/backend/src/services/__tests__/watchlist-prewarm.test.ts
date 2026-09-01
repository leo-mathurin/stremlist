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

interface PrewarmLeaseArgs {
  p_owner_user_id: string;
  p_lease_seconds: number;
  p_lease_token: string;
}

interface ReleaseLeaseArgs {
  p_owner_user_id: string;
  p_lease_token: string;
}

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
    const [acquireFunction, acquireArgs] = supabaseMocks.rpc.mock.calls[0] as [
      string,
      PrewarmLeaseArgs,
    ];
    const [releaseFunction, releaseArgs] = supabaseMocks.rpc.mock.calls[1] as [
      string,
      ReleaseLeaseArgs,
    ];
    expect(acquireFunction).toBe("try_acquire_watchlist_prewarm_lease");
    expect(acquireArgs).toEqual({
      p_owner_user_id: "ur12345678",
      p_lease_seconds: 600,
      p_lease_token: releaseArgs.p_lease_token,
    });
    expect(acquireArgs.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(releaseFunction).toBe("release_watchlist_prewarm_lease");
    expect(releaseArgs).toEqual({
      p_owner_user_id: "ur12345678",
      p_lease_token: acquireArgs.p_lease_token,
    });
  });

  it("releases a completed lease so a later save can prewarm", async () => {
    let activeLeaseToken: string | null = null;
    supabaseMocks.rpc.mockImplementation((functionName, args) => {
      const leaseArgs = args as { p_lease_token: string };
      if (functionName === "try_acquire_watchlist_prewarm_lease") {
        if (activeLeaseToken) {
          return Promise.resolve({ data: false, error: null });
        }
        activeLeaseToken = leaseArgs.p_lease_token;
        return Promise.resolve({ data: true, error: null });
      }

      if (activeLeaseToken === leaseArgs.p_lease_token) {
        activeLeaseToken = null;
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: false, error: null });
    });
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

    await prewarmWatchlists("ur12345678", watchlists);
    await prewarmWatchlists("ur12345678", watchlists);

    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(2);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(4);
    expect(activeLeaseToken).toBeNull();
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

    const [functionName, args] = supabaseMocks.rpc.mock.calls[0] as [
      string,
      PrewarmLeaseArgs,
    ];
    expect(functionName).toBe("try_acquire_watchlist_prewarm_lease");
    expect(args).toEqual({
      p_owner_user_id: "ur12345678",
      p_lease_seconds: 600,
      p_lease_token: args.p_lease_token,
    });
    expect(args.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
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
