import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import type { CatalogData } from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});
vi.mock("../list-cache", async () => {
  const cache = await import("../../__tests__/helpers/mock-list-cache");
  return { ...cache, writeCachedList: vi.fn(cache.writeCachedList) };
});
vi.mock("../../providers/registry", async () => {
  return await import("../../__tests__/helpers/mock-registry");
});

import {
  movie,
  seedAccount,
  seedConnection,
  seedList,
} from "../../__tests__/helpers/fixtures";
import { cache } from "../../__tests__/helpers/mock-list-cache";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import {
  db,
  resetRpc,
  rpcHandlers,
  supabase,
} from "../../__tests__/helpers/mock-supabase";
import {
  ConnectionExpiredError,
  SourceUnavailableError,
} from "../../providers/types";
import { getAccountLists } from "../accounts";
import { listConnections, saveConnection } from "../connections";
import * as listCache from "../list-cache";
import type { ListRead } from "../lists";
import {
  disconnectProvider,
  getListCatalog,
  rereadConnectionLists,
} from "../lists";
import { sourceCaches } from "../merged-lists";
import { getListSyncStatuses } from "../sync-status";

const HOUR = 60 * 60_000;
const WATCHLIST_READ = { sourceRef: "me/watchlist" } as const;

let accountId = "";
let listId = "";

/** A read of one List, its fields and the read options side by side. */
interface TestRead extends ListRead {
  listId: string;
  provider: ProviderId;
  sourceRef: string;
  mergedSources?: ListSource[];
}

/**
 * A catalog read. The fake Providers below never count as fresh, so each
 * read asks the Provider again and a failed one can fall back to the cache.
 */
function read(overrides: Partial<TestRead> = {}): Promise<CatalogData> {
  const fields: TestRead = {
    accountId,
    listId,
    provider: "trakt",
    sourceRef: "users/leo/lists/horror",
    sort: { by: "added_at", order: "asc" },
    rpdbApiKey: null,
    allowConnection: true,
    policy: "catalog",
    ...overrides,
  };
  const { listId: id, provider, sourceRef, mergedSources, ...options } = fields;
  return getListCatalog({ id, provider, sourceRef, mergedSources }, options);
}

function tryRead(overrides: Partial<TestRead> = {}) {
  return read(overrides).catch(() => undefined);
}

function useSource(
  fetchSource: ReturnType<typeof vi.fn>,
  id: ProviderId = "trakt",
) {
  useFakeProvider(
    fakeAdapter(id, { freshnessMs: 0, fetchSource: fetchSource as never }),
  );
}

function entries(...ids: string[]) {
  return { entries: ids.map((id) => ({ imdbId: id, meta: movie(id) })) };
}

const serving = (...ids: string[]) =>
  vi.fn(() => Promise.resolve(entries(...ids)));
const failing = (error: Error) => vi.fn(() => Promise.reject(error));

/** A second Trakt List, read through the Connection. */
function seedWatchlist(): string {
  return seedList(accountId, {
    provider: "trakt",
    source_ref: "me/watchlist",
    position: 1,
  }).id;
}

/** The sync status of the first Source list of a List, if it was read. */
async function statusOf(id = listId) {
  const { syncStatus } = await getListSyncStatuses(
    await getAccountLists(accountId),
  );
  return id in syncStatus ? (syncStatus[id][0] ?? undefined) : undefined;
}

async function needsRenewalSince() {
  return (await listConnections(accountId)).find(
    (connection) => connection.provider === "trakt",
  )?.needsRenewalSince;
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  accountId = seedAccount().id;
  listId = seedList(accountId, {
    provider: "trakt",
    source_ref: "users/leo/lists/horror",
  }).id;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("recording refreshes", () => {
  it("stores the time and Title count of a successful refresh", async () => {
    useSource(serving("tt0000001", "tt0000002"));

    await read();

    expect(await statusOf()).toEqual({
      provider: "trakt",
      sourceRef: "users/leo/lists/horror",
      lastAttemptAt: expect.any(String) as string,
      lastSuccessAt: expect.any(String) as string,
      titleCount: 2,
      problem: null,
      failingSince: null,
    });
  });

  it("keeps the last success when a refresh fails and the cache still serves", async () => {
    useSource(
      vi
        .fn()
        .mockResolvedValueOnce(entries("tt0000001"))
        .mockRejectedValue(new Error("socket hang up")),
    );
    vi.useFakeTimers({
      now: new Date("2026-10-06T10:00:00Z"),
      toFake: ["Date"],
    });
    await read();

    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    // Stremio still gets the cached Titles.
    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    expect(await statusOf()).toMatchObject({
      lastSuccessAt: "2026-10-06T10:00:00.000Z",
      titleCount: 1,
      problem: "unavailable",
      failingSince: "2026-10-06T12:00:00.000Z",
    });
  });

  it("keeps the start of a failure run and ends it on the next success", async () => {
    useSource(
      vi
        .fn()
        .mockRejectedValueOnce(new SourceUnavailableError("private", "private"))
        .mockRejectedValueOnce(new SourceUnavailableError("not_found", "gone"))
        .mockResolvedValue(entries()),
    );
    vi.useFakeTimers({
      now: new Date("2026-10-06T10:00:00Z"),
      toFake: ["Date"],
    });

    await tryRead();
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"));
    await tryRead();

    expect(await statusOf()).toMatchObject({
      problem: "not_found",
      failingSince: "2026-10-06T10:00:00.000Z",
      lastAttemptAt: "2026-10-06T11:00:00.000Z",
      lastSuccessAt: null,
    });

    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    await read();

    // An empty Source list is a success with no Titles, not a failure.
    expect(await statusOf()).toMatchObject({
      problem: null,
      failingSince: null,
      titleCount: 0,
      lastSuccessAt: "2026-10-06T12:00:00.000Z",
    });
  });

  it("records a turned-off Provider without reading it", async () => {
    const fetchSource = vi.fn();
    useSource(fetchSource);
    process.env.DISABLED_PROVIDERS = "trakt";

    await tryRead();

    expect(fetchSource).not.toHaveBeenCalled();
    expect(await statusOf()).toMatchObject({ problem: "disabled" });
  });

  it("records one outcome for concurrent reads of the same List", async () => {
    const record = vi.fn(() => ({ data: true, error: null }));
    rpcHandlers.set("record_list_refresh", record);
    useSource(serving("tt0000001"));

    await Promise.all([read(), read()]);

    expect(record).toHaveBeenCalledOnce();
  });

  it("still serves the Catalog when the status cannot be written", async () => {
    rpcHandlers.set("record_list_refresh", () => ({
      data: null,
      error: { message: "database is down" },
    }));
    useSource(serving("tt0000001"));

    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });
  });

  it("does not report an update whose Catalog could not be saved", async () => {
    vi.mocked(listCache.writeCachedList).mockRejectedValueOnce(
      new Error("R2 is down"),
    );
    useSource(serving("tt0000001"));

    // This request still gets the Titles it read.
    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    expect(db.getTable("list_sync_status")).toEqual([]);
  });

  it("ignores the status of a Source list that the List no longer reads", async () => {
    useSource(serving("tt0000001"));
    await read();

    const [list] = await getAccountLists(accountId);
    const statuses = await getListSyncStatuses([
      { ...list, sourceRef: "users/leo/lists/comedy" },
    ]);

    expect(statuses.syncStatus).toEqual({ [list.id]: [null] });
  });
});

describe("Lists without a recorded status", () => {
  it("take the last refresh from their cached Catalog", async () => {
    cache.seed(
      listId,
      [movie("tt0000001"), movie("tt0000002")],
      new Date("2026-10-06T09:00:00.000Z"),
    );

    expect(await statusOf()).toEqual({
      provider: "trakt",
      sourceRef: "users/leo/lists/horror",
      lastAttemptAt: "2026-10-06T09:00:00.000Z",
      lastSuccessAt: "2026-10-06T09:00:00.000Z",
      titleCount: 2,
      problem: null,
      failingSince: null,
    });
  });

  it("wait for a read when the cache was marked stale or is missing", async () => {
    cache.seed(listId, [movie("tt0000001")], new Date(0));

    expect(await statusOf()).toBeUndefined();
  });

  it("still use the cache when the recorded statuses cannot be read", async () => {
    cache.seed(listId, [movie("tt0000001")]);
    const lists = await getAccountLists(accountId);
    vi.spyOn(supabase, "from").mockReturnValueOnce({
      select: () => ({
        in: () => Promise.resolve({ data: null, error: { message: "down" } }),
      }),
    } as never);

    expect((await getListSyncStatuses(lists)).syncStatus[listId]).toEqual([
      expect.objectContaining({ problem: null, titleCount: 1 }),
    ]);
  });

  it("keep their cached last refresh when their first recorded refresh fails", async () => {
    const cachedAt = new Date(Date.now() - 2 * HOUR);
    cache.seed(listId, [movie("tt0000001"), movie("tt0000002")], cachedAt);
    useSource(failing(new Error("socket hang up")));

    // Stremio still gets the cached Titles.
    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }, { id: "tt0000002" }],
    });

    expect(await statusOf()).toMatchObject({
      problem: "unavailable",
      titleCount: 2,
      lastSuccessAt: cachedAt.toISOString(),
    });
  });

  it("do not take a cache that may hold the List's previous Source list", async () => {
    const hourAgo = new Date(Date.now() - HOUR);
    db.insert("list_sync_status", {
      list_id: listId,
      provider: "trakt",
      source_ref: "users/leo/lists/comedy",
      last_attempt_at: hourAgo.toISOString(),
      last_success_at: hourAgo.toISOString(),
      title_count: 9,
    });
    cache.seed(listId, [movie("tt0000001")], hourAgo);
    useSource(failing(new SourceUnavailableError("private", "no")));

    await tryRead({ policy: "manual" });

    expect(await statusOf()).toMatchObject({
      sourceRef: "users/leo/lists/horror",
      problem: "private",
      lastSuccessAt: null,
      titleCount: null,
    });
  });
});

describe("the read after a new authorization", () => {
  beforeEach(() => {
    seedConnection(accountId, "trakt");
  });

  it("does not join a read that started with the older Connection", async () => {
    const watchlistId = seedWatchlist();
    const first = Promise.withResolvers<ReturnType<typeof entries>>();
    const fetchSource = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(entries("tt0000001"));
    useSource(fetchSource);
    const older = read({ listId: watchlistId, ...WATCHLIST_READ });
    await vi.waitFor(() => {
      expect(fetchSource).toHaveBeenCalledOnce();
    });

    await rereadConnectionLists(accountId, "trakt");

    // Both Trakt Lists were read again; the older read did not count.
    expect(fetchSource).toHaveBeenCalledTimes(3);
    const expected = { problem: null, titleCount: 1 };
    expect(await statusOf(watchlistId)).toMatchObject(expected);
    // The older read ends last and must not undo the new one.
    first.resolve(entries());
    await older;
    expect(await statusOf(watchlistId)).toMatchObject(expected);
    expect(cache.get(watchlistId)?.data.metas).toHaveLength(1);
  });

  it("does not record a late failure of the older read", async () => {
    const first = Promise.withResolvers<never>();
    const fetchSource = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(entries("tt0000001"));
    useSource(fetchSource);
    const older = tryRead();
    await vi.waitFor(() => {
      expect(fetchSource).toHaveBeenCalledOnce();
    });

    await rereadConnectionLists(accountId, "trakt");
    first.reject(new SourceUnavailableError("needs_connection", "old token"));
    await older;

    expect(await statusOf()).toMatchObject({ problem: null, titleCount: 1 });
  });
});

describe("Connections that need to be renewed", () => {
  beforeEach(() => {
    seedConnection(accountId, "trakt");
  });

  it.each([
    [
      "marks the Connection when the Provider refuses it",
      new SourceUnavailableError("needs_connection", "token refused"),
      {},
      true,
      "needs_connection",
    ],
    [
      "marks the Connection when its token cannot be refreshed",
      new ConnectionExpiredError("trakt"),
      {},
      true,
      "needs_connection",
    ],
    [
      "does not mark the Connection for other failures",
      new Error("timeout"),
      {},
      false,
      "unavailable",
    ],
    [
      "does not mark anything for a read without a Connection",
      new SourceUnavailableError("needs_connection", "no"),
      { allowConnection: false },
      false,
      "needs_connection",
    ],
  ])("%s", async (_, error, overrides, marked, problem) => {
    useSource(failing(error));

    await tryRead(overrides);

    expect(await needsRenewalSince()).toEqual(
      marked ? expect.any(String) : null,
    );
    expect(await statusOf()).toMatchObject({ problem });
  });

  it("clears the mark when a private Source list reads through the Connection again", async () => {
    useSource(
      vi
        .fn()
        .mockRejectedValueOnce(new ConnectionExpiredError("trakt"))
        .mockResolvedValue(entries("tt0000001")),
    );
    const watchlist = { listId: seedWatchlist(), ...WATCHLIST_READ };

    await tryRead(watchlist);
    await read(watchlist);

    expect(await needsRenewalSince()).toBeNull();
  });

  it("clears the mark after a private read whose Catalog could not be saved", async () => {
    vi.mocked(listCache.writeCachedList).mockRejectedValueOnce(
      new Error("R2 is down"),
    );
    useSource(serving("tt0000001"));
    const watchlistId = seedWatchlist();
    db.getTable("connections")[0].needs_renewal_since =
      new Date().toISOString();

    await read({ listId: watchlistId, ...WATCHLIST_READ });

    expect(await needsRenewalSince()).toBeNull();
    // The List status waits for a saved Catalog.
    expect(await statusOf(watchlistId)).toBeUndefined();
  });

  it("keeps the mark when only a public Source list reads fine", async () => {
    useSource(
      vi
        .fn()
        .mockRejectedValueOnce(new ConnectionExpiredError("trakt"))
        .mockResolvedValue(entries("tt0000001")),
    );

    await tryRead();
    // Trakt reads a public list without the refused Connection.
    await read();

    expect(await needsRenewalSince()).not.toBeNull();
    expect(await statusOf()).toMatchObject({ problem: null, titleCount: 1 });
  });

  it("clears the mark when the user connects again", async () => {
    useSource(failing(new ConnectionExpiredError("trakt")));
    await tryRead();

    await saveConnection(
      accountId,
      "trakt",
      { accessToken: "new", refreshToken: "new", expiresAt: null, scope: null },
      "leo",
      "https://api.stremlist.test/oauth/trakt/callback",
    );

    expect(await needsRenewalSince()).toBeNull();
  });
});

describe("merged Lists", () => {
  const WATCHLIST = { provider: "trakt", sourceRef: "me/watchlist" } as const;
  let mergedId = "";
  let keys = { imdb: "", trakt: "" };

  beforeEach(async () => {
    mergedId = seedList(accountId, {
      provider: "imdb",
      source_ref: "ur1000001",
      position: 1,
      merged_sources: [
        { provider: WATCHLIST.provider, source_ref: WATCHLIST.sourceRef },
      ],
    }).id;
    const list = (await getAccountLists(accountId)).find(
      (candidate) => candidate.id === mergedId,
    );
    if (!list) throw new Error("merged List missing");
    const [imdb, trakt] = sourceCaches(list);
    keys = { imdb: imdb.cacheKey, trakt: trakt.cacheKey };
  });

  async function mergedStatus() {
    const { syncStatus } = await getListSyncStatuses(
      await getAccountLists(accountId),
    );
    return syncStatus[mergedId];
  }

  it("record each Source list under the List, in the List's order", async () => {
    seedConnection(accountId, "trakt");
    useSource(serving("tt0000001", "tt0000002"), "imdb");
    useSource(
      failing(new SourceUnavailableError("needs_connection", "token refused")),
    );

    // The IMDb Source list still shows.
    await expect(
      read({
        listId: mergedId,
        provider: "imdb",
        sourceRef: "ur1000001",
        mergedSources: [WATCHLIST],
      }),
    ).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }, { id: "tt0000002" }],
    });

    expect(
      db
        .getTable("list_sync_status")
        .map((row) => [row.list_id, row.provider, row.source_ref]),
    ).toEqual(
      expect.arrayContaining([
        [mergedId, "imdb", "ur1000001"],
        [mergedId, "trakt", "me/watchlist"],
      ]),
    );
    expect(await mergedStatus()).toEqual([
      expect.objectContaining({
        provider: "imdb",
        sourceRef: "ur1000001",
        problem: null,
        titleCount: 2,
      }),
      expect.objectContaining({
        provider: "trakt",
        sourceRef: "me/watchlist",
        problem: "needs_connection",
      }),
    ]);
  });

  it("take the last refresh of each Source list from its own cache", async () => {
    seedConnection(accountId, "trakt");
    cache.seed(
      keys.imdb,
      [movie("tt0000001")],
      new Date("2026-10-06T08:00:00Z"),
    );
    cache.seed(
      keys.trakt,
      [movie("tt0000002"), movie("tt0000003")],
      new Date("2026-10-06T09:00:00Z"),
    );

    expect(await mergedStatus()).toEqual([
      expect.objectContaining({
        provider: "imdb",
        lastSuccessAt: "2026-10-06T08:00:00.000Z",
        titleCount: 1,
      }),
      expect.objectContaining({
        provider: "trakt",
        sourceRef: "me/watchlist",
        lastSuccessAt: "2026-10-06T09:00:00.000Z",
        titleCount: 2,
      }),
    ]);
  });

  it("give no status to the Source lists that were never read", async () => {
    seedConnection(accountId, "trakt");
    cache.seed(keys.trakt, [movie("tt0000002")]);

    expect(await mergedStatus()).toEqual([
      null,
      expect.objectContaining({ provider: "trakt" }),
    ]);
  });

  it("forget only the Source lists read through a Connection that goes away", async () => {
    cache.seed(keys.imdb, [movie("tt0000001")]);
    cache.seed(keys.trakt, [movie("tt0000002")]);
    for (const [provider, sourceRef] of [
      ["imdb", "ur1000001"],
      ["trakt", "me/watchlist"],
    ]) {
      db.insert("list_sync_status", {
        list_id: mergedId,
        provider,
        source_ref: sourceRef,
        last_attempt_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        title_count: 1,
      });
    }
    seedConnection(accountId, "trakt");

    await disconnectProvider(accountId, "trakt");

    expect(cache.get(keys.imdb)).not.toBeNull();
    expect(cache.get(keys.trakt)).toBeNull();
    expect(db.getTable("list_sync_status").map((row) => row.provider)).toEqual([
      "imdb",
    ]);
  });

  it("read the merged Source lists of a new Connection again, in their own cache", async () => {
    seedConnection(accountId, "trakt");
    const imdbRead = serving("tt0000009");
    useSource(imdbRead, "imdb");
    const traktRead = serving("tt0000002");
    useSource(traktRead);

    await rereadConnectionLists(accountId, "trakt");

    expect(imdbRead).not.toHaveBeenCalled();
    expect(traktRead).toHaveBeenCalledWith("me/watchlist", expect.anything());
    expect(cache.get(keys.trakt)?.data.metas).toHaveLength(1);
    expect((await mergedStatus())[1]).toEqual(
      expect.objectContaining({ provider: "trakt", titleCount: 1 }),
    );
  });
});
