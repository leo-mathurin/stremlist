import type { ConfigList } from "@stremlist/shared/stremio.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMocks = vi.hoisted(() => ({ getListCatalog: vi.fn() }));
const supabaseMocks = vi.hoisted(() => ({ rpc: vi.fn() }));
const accountMocks = vi.hoisted(() => ({ getAccountLists: vi.fn() }));

vi.mock("../lists", () => listMocks);
vi.mock("../accounts", () => accountMocks);
vi.mock("../../lib/supabase", () => ({
  supabase: { rpc: supabaseMocks.rpc },
}));

import { LIST_IDS } from "../../__tests__/helpers/fixtures";
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

/** Makes each List read wait until the test finishes it. */
function holdReads(): (() => void)[] {
  const finishFetches: (() => void)[] = [];
  listMocks.getListCatalog.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishFetches.push(() => {
          resolve({ metas: [] });
        });
      }),
  );
  return finishFetches;
}

const ACCOUNT_ID = "sl_AbCdEfGhIjKlMnOpQrStUv";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function savedList(
  position: number,
  overrides: Partial<ConfigList> = {},
): ConfigList {
  return {
    id: LIST_IDS[position],
    provider: "imdb",
    sourceRef: `ur1234567${position}`,
    catalogTitle: "Mine",
    sortOption: "added_at-asc",
    displayMode: "split",
    position,
    ...overrides,
  };
}

const SAVED_LISTS = [savedList(0)];

function expectRequest(args: RequestPrewarmArgs): void {
  expect(args).toEqual({
    p_account_id: ACCOUNT_ID,
    p_lease_seconds: 600,
    p_lease_token: expect.stringMatching(UUID) as unknown,
  });
}

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
      [...SAVED_LISTS, savedList(1, { sortOption: "year-desc" })],
      true,
    );

    expect(listMocks.getListCatalog).toHaveBeenCalledTimes(2);
    for (const [index, sort] of [
      { by: "added_at", order: "asc" },
      { by: "year", order: "desc" },
    ].entries()) {
      expect(listMocks.getListCatalog).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          id: LIST_IDS[index],
          sourceRef: `ur1234567${index}`,
        }),
        {
          accountId: ACCOUNT_ID,
          sort,
          rpdbApiKey: null,
          allowConnection: true,
          policy: "prewarm",
        },
      );
    }
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 2\/2 lists in \d+ms$/),
    );
    const [[requestFunction, requestArgs], [finishFunction, finishArgs]] =
      supabaseMocks.rpc.mock.calls as [
        [string, RequestPrewarmArgs],
        [string, FinishPrewarmArgs],
      ];
    expect(requestFunction).toBe("request_list_prewarm");
    expectRequest(requestArgs);
    expect(finishFunction).toBe("finish_list_prewarm");
    expect(finishArgs).toEqual({
      ...requestArgs,
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
      prewarmLists(ACCOUNT_ID, [savedList(0), savedList(1)], true),
    ).resolves.toBeUndefined();

    expect(listMocks.getListCatalog).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      `Failed to prewarm list ${LIST_IDS[0]}:`,
      expect.any(Error),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 1\/2 lists in \d+ms$/),
    );
  });

  it("runs at most two prewarms concurrently", async () => {
    const finishFetches = holdReads();

    const batch = prewarmLists(
      ACCOUNT_ID,
      [0, 1, 2].map((position) => savedList(position)),
      true,
    );

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
    const finishFetches = holdReads();
    const changedLists = [...SAVED_LISTS, savedList(1)];
    accountMocks.getAccountLists.mockResolvedValue(changedLists);

    const first = prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);
    await vi.waitFor(() => {
      expect(listMocks.getListCatalog).toHaveBeenCalledOnce();
    });
    await prewarmLists(ACCOUNT_ID, changedLists, true);

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
    expectRequest(args);
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
