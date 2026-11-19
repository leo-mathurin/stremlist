import type { ConfigList, StremioMeta } from "@stremlist/shared/stremio.types";
import { http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";
import {
  LIST_IDS,
  movie,
  seedAccount,
  seedList,
} from "../../test/helpers/account.fixture";
import { FakeImdb, IMDB_GRAPHQL } from "../../test/helpers/imdb.test-utils";
import { cache } from "../../test/helpers/list-cache.test-utils";
import { db, resetRpc, rpcCalls } from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import * as TitlePosters from "../../titles/title-posters";
import * as Lists from "../lists";
import { prewarmLists } from "../list-prewarm";

const getListCatalog = vi.spyOn(Lists, "getListCatalog");
const findPosters = vi.spyOn(TitlePosters, "findPosters");

const imdb = new FakeImdb();
const server = useMswServer();

const requestPrewarmArgs = z
  .object({
    p_account_id: z.string(),
    p_lease_seconds: z.number(),
    p_lease_token: z.string(),
  })
  .loose();

function prewarmCalls() {
  return rpcCalls
    .filter(({ name }) => name.endsWith("_list_prewarm"))
    .map(({ name, args }) => [name, args] as const);
}

function readListIds() {
  return getListCatalog.mock.calls.map(([list]) => list.id);
}

interface HeldRead {
  arrived: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
}

function holdReads() {
  const reads: HeldRead[] = [];
  let releasedAll = false;
  const read = (index: number) => {
    const held = (reads[index] ??= {
      arrived: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    });
    if (releasedAll) held.release.resolve();
    return held;
  };
  let count = 0;
  server.use(
    http.post(IMDB_GRAPHQL, async ({ request }) => {
      const held = read(count);
      count += 1;
      held.arrived.resolve();
      await held.release.promise;
      return imdb.answer(request);
    }),
  );
  return {
    arrived: (index: number) => read(index).arrived.promise,
    finish: (index: number) => {
      read(index).release.resolve();
    },
    finishAll: () => {
      releasedAll = true;
      for (const held of reads) held.release.resolve();
    },
  };
}

const ACCOUNT_ID = "sl_AbCdEfGhIjKlMnOpQrStUv";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function savedList(position: number, overrides: Partial<ConfigList> = {}) {
  const value: ConfigList = {
    id: LIST_IDS[position],
    provider: "imdb",
    sourceRef: `ur1234567${position}`,
    catalogTitle: "Mine",
    sortOption: "added_at-asc",
    displayMode: "split",
    position,
    ...overrides,
  };
  return value;
}

const SAVED_LISTS = [savedList(0)];

function saveLists(lists: ConfigList[]) {
  for (const list of lists) {
    seedList(ACCOUNT_ID, {
      id: list.id,
      provider: list.provider,
      source_ref: list.sourceRef,
      catalog_title: list.catalogTitle,
      sort_option: list.sortOption,
      display_mode: list.displayMode,
      position: list.position,
    });
  }
}

function titles(type: "movie" | "series", count: number) {
  return Array.from({ length: count }, (_, index) =>
    movie(`tt${type === "movie" ? 1 : 2}${String(index).padStart(6, "0")}`, {
      type,
    }),
  );
}

function expectRequest(args: unknown) {
  expect(args).toEqual({
    p_account_id: ACCOUNT_ID,
    p_lease_seconds: 600,
    p_lease_token: expect.stringMatching(UUID) as unknown,
  });
}

describe("prewarmLists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
    vi.stubEnv("TMDB_API_KEY", "");
    db.reset();
    resetRpc();
    cache.reset();
    imdb.reset();
    server.use(imdb.handler);
    seedAccount({ id: ACCOUNT_ID });
    saveLists(SAVED_LISTS);
    for (const position of [0, 1, 2]) {
      imdb.watchlists.set(savedList(position).sourceRef, []);
    }
    vi.spyOn(console, "log");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("looks up the TMDB posters of the first page of each shown Catalog", async () => {
    const metas: StremioMeta[] = [
      ...titles("movie", 150),
      ...titles("series", 3),
    ];
    for (const position of [0, 1]) {
      imdb.watchlists.set(savedList(position).sourceRef, metas);
    }
    findPosters.mockClear();

    await prewarmLists(
      ACCOUNT_ID,
      [savedList(0), savedList(1, { displayMode: "movie" })],
      true,
      { posterSource: "tmdb", rpdbApiKey: null },
    );

    const calls = findPosters.mock.calls.map(([source, metas]) => {
      expect(source).toBe("tmdb");
      return metas.map((meta) => meta.type);
    });
    expect(calls.map((types) => `${types[0]}:${types.length}`).sort()).toEqual([
      "movie:100",
      "movie:100",
      "series:3",
    ]);
    expect(calls.every((types) => new Set(types).size === 1)).toBe(true);

    findPosters.mockClear();
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true, {
      posterSource: "rpdb",
      rpdbApiKey: "key",
    });
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true, {
      posterSource: "imdb",
      rpdbApiKey: null,
    });
    expect(findPosters).not.toHaveBeenCalled();
  });

  it("uses the cache-first fetch path for every saved List", async () => {
    await prewarmLists(
      ACCOUNT_ID,
      [...SAVED_LISTS, savedList(1, { sortOption: "year-desc" })],
      true,
    );

    expect(getListCatalog).toHaveBeenCalledTimes(2);
    for (const [index, sort] of [
      { by: "added_at", order: "asc" },
      { by: "year", order: "desc" },
    ].entries()) {
      expect(getListCatalog).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          id: LIST_IDS[index],
          sourceRef: `ur1234567${index}`,
        }),
        {
          accountId: ACCOUNT_ID,
          sort,
          allowConnection: true,
          policy: "prewarm",
          queueDeadline: expect.any(Number) as unknown,
        },
      );
    }
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 2\/2 lists in \d+ms$/),
    );
    const [[requestFunction, rawRequestArgs], [finishFunction, finishArgs]] =
      prewarmCalls();
    expect(requestFunction).toBe("request_list_prewarm");
    expectRequest(rawRequestArgs);
    const requestArgs = requestPrewarmArgs.parse(rawRequestArgs);
    expect(finishFunction).toBe("finish_list_prewarm");
    expect(finishArgs).toEqual({
      ...requestArgs,
      p_completed_generation: 1,
    });
  });

  it("releases a completed lease so a later save can prewarm", async () => {
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);

    expect(getListCatalog).toHaveBeenCalledTimes(2);
    expect(prewarmCalls()).toHaveLength(4);
  });

  it("continues the batch when one prewarm fails", async () => {
    imdb.watchlists.delete(savedList(0).sourceRef);
    const error = vi.spyOn(console, "error");

    await expect(
      prewarmLists(ACCOUNT_ID, [savedList(0), savedList(1)], true),
    ).resolves.toBeUndefined();

    expect(getListCatalog).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      `Failed to prewarm list ${LIST_IDS[0]}:`,
      expect.any(Error),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Prewarmed 1\/2 lists in \d+ms$/),
    );
  });

  it("runs at most two prewarms concurrently", async () => {
    const reads = holdReads();

    const batch = prewarmLists(
      ACCOUNT_ID,
      [0, 1, 2].map((position) => savedList(position)),
      true,
    );

    try {
      await Promise.all([reads.arrived(0), reads.arrived(1)]);
      expect(getListCatalog).toHaveBeenCalledTimes(2);
      reads.finish(0);
      await reads.arrived(2);
      expect(getListCatalog).toHaveBeenCalledTimes(3);
      reads.finish(1);
      reads.finish(2);
    } finally {
      reads.finishAll();
    }
    await batch;
  });

  it("picks up a cross-instance request after the active batch", async () => {
    const reads = holdReads();
    const changedLists = [...SAVED_LISTS, savedList(1)];

    const first = prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);
    try {
      await reads.arrived(0);
      expect(getListCatalog).toHaveBeenCalledOnce();
      saveLists([savedList(1)]);
      await prewarmLists(ACCOUNT_ID, changedLists, true);

      expect(getListCatalog).toHaveBeenCalledOnce();
      reads.finish(0);
      await Promise.all([reads.arrived(1), reads.arrived(2)]);
      expect(getListCatalog).toHaveBeenCalledTimes(3);
      reads.finish(1);
      reads.finish(2);
    } finally {
      reads.finishAll();
    }
    await first;
    expect(readListIds()).toEqual([LIST_IDS[0], LIST_IDS[0], LIST_IDS[1]]);
  });

  it("records the request without starting another worker when the lease is held", async () => {
    const [account] = db.getTable("accounts");
    account.prewarm_lease_token = "another-instance";
    account.prewarm_locked_until = new Date(Date.now() + 60_000).toISOString();

    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);

    const [[functionName, args]] = prewarmCalls();
    expect(functionName).toBe("request_list_prewarm");
    expectRequest(args);
    expect(getListCatalog).not.toHaveBeenCalled();
  });

  it("fails closed when the database request cannot be recorded", async () => {
    const error = vi.spyOn(console, "error");
    db.unavailable = true;

    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, true);

    expect(getListCatalog).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      `Failed to request prewarm for ${ACCOUNT_ID}:`,
      expect.objectContaining({ message: "database unavailable" }),
    );
  });

  it("never reads through a Connection when a Legacy alias saved", async () => {
    await prewarmLists(ACCOUNT_ID, SAVED_LISTS, false);

    expect(getListCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ allowConnection: false }),
    );
  });
});
