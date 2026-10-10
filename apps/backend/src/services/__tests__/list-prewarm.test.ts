import type { ConfigList } from "@stremlist/shared/stremio.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMocks = vi.hoisted(() => ({
  getListCatalog: vi.fn(),
}));
const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
const accountMocks = vi.hoisted(() => ({
  getAccountLists: vi.fn(),
}));

vi.mock("../lists", () => listMocks);
vi.mock("../accounts", () => accountMocks);
vi.mock("../../lib/supabase", () => ({
  supabase: { rpc: supabaseMocks.rpc },
}));

import { prewarmLists } from "../list-prewarm";

interface RequestPrewarmArgs {
  p_account_id: string;
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
    if (functionName === "request_list_prewarm") {
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

const ACCOUNT_ID = "sl_AbCdEfGhIjKlMnOpQrStUv";

const SAVED_LISTS: ConfigList[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "imdb",
    sourceRef: "ur12345678",
    catalogTitle: "Mine",
    sortOption: "added_at-asc",
    displayMode: "split",
    position: 0,
  },
];

describe("prewarmLists", () => {
  beforeEach(() => {
    listMocks.getListCatalog.mockReset();
    listMocks.getListCatalog.mockResolvedValue({ metas: [] });
    accountMocks.getAccountLists.mockReset();
    accountMocks.getAccountLists.mockResolvedValue(SAVED_LISTS);
    supabaseMocks.rpc.mockReset();
    mockPrewarmQueue();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("uses the cache-first fetch path for every saved List", async () => {
    await prewarmLists(
      ACCOUNT_ID,
      [
        ...SAVED_LISTS,
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "imdb",
          sourceRef: "ls123456789",
          catalogTitle: "List",
          sortOption: "year-desc",
          displayMode: "split",
          position: 1,
        },
      ],
      true,
    );

    expect(listMocks.getListCatalog).toHaveBeenCalledTimes(2);
    expect(listMocks.getListCatalog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        sourceRef: "ur12345678",
      }),
      {
        accountId: ACCOUNT_ID,
        sort: { by: "added_at", order: "asc" },
        rpdbApiKey: null,
        allowConnection: true,
        policy: "prewarm",
      },
    );
    expect(listMocks.getListCatalog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "22222222-2222-4222-8222-222222222222",
        sourceRef: "ls123456789",
      }),
      {
        accountId: ACCOUNT_ID,
        sort: { by: "year", order: "desc" },
        rpdbApiKey: null,
        allowConnection: true,
        policy: "prewarm",
      },
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 2\/2 lists in \d+ms$/),
    );
    const [requestFunction, requestArgs] = supabaseMocks.rpc.mock.calls[0] as [
      string,
      RequestPrewarmArgs,
    ];
    const [finishFunction, finishArgs] = supabaseMocks.rpc.mock.calls[1] as [
      string,
      FinishPrewarmArgs,
    ];
    expect(requestFunction).toBe("request_list_prewarm");
    expect(requestArgs).toEqual({
      p_account_id: ACCOUNT_ID,
      p_lease_seconds: 600,
      p_lease_token: finishArgs.p_lease_token,
    });
    expect(requestArgs.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(finishFunction).toBe("finish_list_prewarm");
    expect(finishArgs).toEqual({
      p_account_id: ACCOUNT_ID,
      p_lease_seconds: 600,
      p_lease_token: requestArgs.p_lease_token,
      p_completed_generation: 1,
    });
  });

  it("releases a completed lease so a later save can prewarm", async () => {
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);

    expect(listMocks.getListCatalog).toHaveBeenCalledTimes(2);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(4);
  });

  it("continues the batch when one prewarm fails", async () => {
    listMocks.getListCatalog.mockRejectedValueOnce(
      new Error("IMDb unavailable"),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      prewarmLists(
        ACCOUNT_ID,
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider: "imdb",
            sourceRef: "ur12345678",
            catalogTitle: "",
            sortOption: "added_at-asc",
            displayMode: "split",
            position: 0,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            provider: "imdb",
            sourceRef: "ls123456789",
            catalogTitle: "Still runs",
            sortOption: "added_at-asc",
            displayMode: "split",
            position: 1,
          },
        ],
        true,
      ),
    ).resolves.toBeUndefined();

    expect(listMocks.getListCatalog).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "Failed to prewarm list 11111111-1111-4111-8111-111111111111:",
      expect.any(Error),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 1\/2 lists in \d+ms$/),
    );
  });

  it("runs at most two prewarms concurrently", async () => {
    const finishFetches: (() => void)[] = [];
    listMocks.getListCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetches.push(() => {
            resolve({ metas: [] });
          });
        }),
    );
    const lists = Array.from({ length: 3 }, (_, index) => ({
      id: `${index + 1}1111111-1111-4111-8111-111111111111`,
      provider: "imdb" as const,
      sourceRef: `ur1234567${index}`,
      catalogTitle: String(index),
      sortOption: "added_at-asc",
      displayMode: "split" as const,
      position: index,
    }));

    const batch = prewarmLists(ACCOUNT_ID, lists, true);

    await vi.waitFor(() => {
      expect(listMocks.getListCatalog).toHaveBeenCalledTimes(2);
    });
    finishFetches[0]();
    await vi.waitFor(() => {
      expect(listMocks.getListCatalog).toHaveBeenCalledTimes(3);
    });
    finishFetches.slice(1).forEach((finish) => {
      finish();
    });
    await batch;
  });

  it("picks up a cross-instance request after the active batch", async () => {
    const finishFetches: (() => void)[] = [];
    listMocks.getListCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetches.push(() => {
            resolve({ metas: [] });
          });
        }),
    );
    const firstLists = SAVED_LISTS;
    const changedLists: ConfigList[] = [
      ...firstLists,
      {
        id: "22222222-2222-4222-8222-222222222222",
        provider: "imdb" as const,
        sourceRef: "ur87654321",
        catalogTitle: "Friend",
        sortOption: "added_at-asc",
        displayMode: "split" as const,
        position: 1,
      },
    ];
    accountMocks.getAccountLists.mockResolvedValue(changedLists);

    const first = prewarmLists(ACCOUNT_ID, firstLists, true);
    await vi.waitFor(() => {
      expect(listMocks.getListCatalog).toHaveBeenCalledOnce();
    });
    const second = prewarmLists(ACCOUNT_ID, changedLists, true);

    await second;
    expect(listMocks.getListCatalog).toHaveBeenCalledOnce();
    finishFetches[0]();
    await vi.waitFor(() => {
      expect(listMocks.getListCatalog).toHaveBeenCalledTimes(3);
    });
    finishFetches.slice(1).forEach((finish) => {
      finish();
    });
    await first;
    expect(accountMocks.getAccountLists).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("records the request without starting another worker when the lease is held", async () => {
    supabaseMocks.rpc.mockResolvedValue({ data: null, error: null });

    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);

    const [functionName, args] = supabaseMocks.rpc.mock.calls[0] as [
      string,
      RequestPrewarmArgs,
    ];
    expect(functionName).toBe("request_list_prewarm");
    expect(args).toEqual({
      p_account_id: ACCOUNT_ID,
      p_lease_seconds: 600,
      p_lease_token: args.p_lease_token,
    });
    expect(args.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(listMocks.getListCatalog).not.toHaveBeenCalled();
  });

  it("fails closed when the database request cannot be recorded", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    supabaseMocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });

    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);

    expect(listMocks.getListCatalog).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      `Failed to request prewarm for ${ACCOUNT_ID}:`,
      expect.objectContaining({ message: "database unavailable" }),
    );
  });

  it("never reads through a Connection when a Legacy alias saved", async () => {
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, false);

    expect(listMocks.getListCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ allowConnection: false }),
    );
  });
});
