import type { ConfigWatchlist } from "@stremlist/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const watchlistMocks = vi.hoisted(() => ({
  getWatchlistByConfig: vi.fn(),
}));
const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
const userMocks = vi.hoisted(() => ({
  getUserWatchlists: vi.fn(),
}));

vi.mock("../watchlist", () => watchlistMocks);
vi.mock("../user", () => userMocks);
vi.mock("../../lib/supabase", () => ({
  supabase: { rpc: supabaseMocks.rpc },
}));

import { prewarmWatchlists } from "../watchlist-prewarm";

interface RequestPrewarmArgs {
  p_owner_user_id: string;
  p_lease_seconds: number;
  p_lease_token: string;
}

interface FinishPrewarmArgs extends RequestPrewarmArgs {
  p_completed_generation: number;
}

function mockPrewarmQueue(): void {
  let generation = 0;
  let activeLeaseToken: string | null = null;

  supabaseMocks.rpc.mockImplementation((functionName, rawArgs) => {
    if (functionName === "request_watchlist_prewarm") {
      const args = rawArgs as RequestPrewarmArgs;
      generation += 1;
      activeLeaseToken ??= args.p_lease_token;
      return Promise.resolve({
        data: activeLeaseToken === args.p_lease_token ? generation : null,
        error: null,
      });
    }

    const args = rawArgs as FinishPrewarmArgs;
    if (activeLeaseToken !== args.p_lease_token) {
      return Promise.resolve({ data: null, error: null });
    }
    if (generation > args.p_completed_generation) {
      return Promise.resolve({ data: generation, error: null });
    }
    activeLeaseToken = null;
    return Promise.resolve({ data: null, error: null });
  });
}

const SAVED_WATCHLISTS: ConfigWatchlist[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    imdbUserId: "ur12345678",
    catalogTitle: "Mine",
    sortOption: "added_at-asc",
    displayMode: "split",
    position: 0,
  },
];

describe("prewarmWatchlists", () => {
  beforeEach(() => {
    watchlistMocks.getWatchlistByConfig.mockReset();
    watchlistMocks.getWatchlistByConfig.mockResolvedValue({ metas: [] });
    userMocks.getUserWatchlists.mockReset();
    userMocks.getUserWatchlists.mockResolvedValue(SAVED_WATCHLISTS);
    supabaseMocks.rpc.mockReset();
    mockPrewarmQueue();
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
    const [requestFunction, requestArgs] = supabaseMocks.rpc.mock.calls[0] as [
      string,
      RequestPrewarmArgs,
    ];
    const [finishFunction, finishArgs] = supabaseMocks.rpc.mock.calls[1] as [
      string,
      FinishPrewarmArgs,
    ];
    expect(requestFunction).toBe("request_watchlist_prewarm");
    expect(requestArgs).toEqual({
      p_owner_user_id: "ur12345678",
      p_lease_seconds: 600,
      p_lease_token: finishArgs.p_lease_token,
    });
    expect(requestArgs.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(finishFunction).toBe("finish_watchlist_prewarm");
    expect(finishArgs).toEqual({
      p_owner_user_id: "ur12345678",
      p_lease_seconds: 600,
      p_lease_token: requestArgs.p_lease_token,
      p_completed_generation: 1,
    });
  });

  it("releases a completed lease so a later save can prewarm", async () => {
    await prewarmWatchlists("ur12345678", SAVED_WATCHLISTS);
    await prewarmWatchlists("ur12345678", SAVED_WATCHLISTS);

    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(2);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(4);
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

  it("picks up a cross-instance request after the active batch", async () => {
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
    userMocks.getUserWatchlists.mockResolvedValue(changedWatchlists);

    const first = prewarmWatchlists("ur12345678", firstWatchlists);
    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledOnce();
    });
    const second = prewarmWatchlists("ur12345678", changedWatchlists);

    await second;
    expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledOnce();
    finishFetches[0]();
    await vi.waitFor(() => {
      expect(watchlistMocks.getWatchlistByConfig).toHaveBeenCalledTimes(3);
    });
    finishFetches.slice(1).forEach((finish) => {
      finish();
    });
    await first;
    expect(userMocks.getUserWatchlists).toHaveBeenCalledWith("ur12345678");
  });

  it("records the request without starting another worker when the lease is held", async () => {
    supabaseMocks.rpc.mockResolvedValue({ data: null, error: null });

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
      RequestPrewarmArgs,
    ];
    expect(functionName).toBe("request_watchlist_prewarm");
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

  it("fails closed when the database request cannot be recorded", async () => {
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
      "Failed to request prewarm for ur12345678:",
      expect.objectContaining({ message: "database unavailable" }),
    );
  });
});
