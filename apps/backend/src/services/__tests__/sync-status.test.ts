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

let accountId = "";
let listId = "";

/** A read of one List, its fields and the read options side by side. */
interface TestRead extends ListRead {
  listId: string;
  provider: ProviderId;
  sourceRef: string;
  mergedSources?: ListSource[];
}

function readList({
  listId,
  provider,
  sourceRef,
  mergedSources,
  ...read
}: TestRead): Promise<CatalogData> {
  return getListCatalog(
    { id: listId, provider, sourceRef, mergedSources },
    read,
  );
}

/**
 * A catalog read. The fake Providers below never count as fresh, so each
 * read asks the Provider again and a failed one can fall back to the cache.
 */
function config(overrides: Partial<TestRead> = {}): TestRead {
  return {
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
}

function useTrakt(fetchSource: ReturnType<typeof vi.fn>) {
  useFakeProvider(
    fakeAdapter("trakt", {
      freshnessMs: 0,
      fetchSource: fetchSource as never,
    }),
  );
}

function entries(...ids: string[]) {
  return { entries: ids.map((id) => ({ imdbId: id, meta: movie(id) })) };
}

/** The sync status of the first Source list of a List, if it was read. */
async function statusOf(id = listId) {
  const { syncStatus } = await getListSyncStatuses(
    await getAccountLists(accountId),
  );
  return id in syncStatus ? (syncStatus[id][0] ?? undefined) : undefined;
}

async function connectionOf() {
  return (await listConnections(accountId)).find(
    (connection) => connection.provider === "trakt",
  );
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
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001", "tt0000002"))));

    await readList(config());

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
    const fetchSource = vi
      .fn()
      .mockResolvedValueOnce(entries("tt0000001"))
      .mockRejectedValue(new Error("socket hang up"));
    useTrakt(fetchSource);
    vi.useFakeTimers({
      now: new Date("2026-10-06T10:00:00Z"),
      toFake: ["Date"],
    });
    await readList(config());

    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    // Stremio still gets the cached Titles.
    await expect(readList(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    const status = await statusOf();
    expect(status).toMatchObject({
      lastSuccessAt: "2026-10-06T10:00:00.000Z",
      titleCount: 1,
      problem: "unavailable",
      failingSince: "2026-10-06T12:00:00.000Z",
    });
  });

  it("keeps the start of a failure run and ends it on the next success", async () => {
    const fetchSource = vi
      .fn()
      .mockRejectedValueOnce(new SourceUnavailableError("private", "private"))
      .mockRejectedValueOnce(new SourceUnavailableError("not_found", "gone"))
      .mockResolvedValue(entries());
    useTrakt(fetchSource);
    vi.useFakeTimers({
      now: new Date("2026-10-06T10:00:00Z"),
      toFake: ["Date"],
    });

    await readList(config()).catch(() => undefined);
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"));
    await readList(config()).catch(() => undefined);

    expect(await statusOf()).toMatchObject({
      problem: "not_found",
      failingSince: "2026-10-06T10:00:00.000Z",
      lastAttemptAt: "2026-10-06T11:00:00.000Z",
      lastSuccessAt: null,
    });

    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    await readList(config());

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
    useTrakt(fetchSource);
    process.env.DISABLED_PROVIDERS = "trakt";

    await readList(config()).catch(() => undefined);

    expect(fetchSource).not.toHaveBeenCalled();
    expect(await statusOf()).toMatchObject({ problem: "disabled" });
  });

  it("records one outcome for concurrent reads of the same List", async () => {
    const record = vi.fn(() => ({ data: true, error: null }));
    rpcHandlers.set("record_list_refresh", record);
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));

    await Promise.all([readList(config()), readList(config())]);

    expect(record).toHaveBeenCalledOnce();
  });

  it("still serves the Catalog when the status cannot be written", async () => {
    rpcHandlers.set("record_list_refresh", () => ({
      data: null,
      error: { message: "database is down" },
    }));
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));

    await expect(readList(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });
  });

  it("does not report an update whose Catalog could not be saved", async () => {
    vi.mocked(listCache.writeCachedList).mockRejectedValueOnce(
      new Error("R2 is down"),
    );
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));

    // This request still gets the Titles it read.
    await expect(readList(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    expect(db.getTable("list_sync_status")).toEqual([]);
  });

  it("ignores the status of a Source list that the List no longer reads", async () => {
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));
    await readList(config());

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
    const from = vi.spyOn(supabase, "from");
    from.mockReturnValueOnce({
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
    useTrakt(vi.fn(() => Promise.reject(new Error("socket hang up"))));

    // Stremio still gets the cached Titles.
    await expect(readList(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }, { id: "tt0000002" }],
    });

    const status = await statusOf();
    expect(status).toMatchObject({
      problem: "unavailable",
      titleCount: 2,
      lastSuccessAt: cachedAt.toISOString(),
    });
  });

  it("do not take a cache that may hold the List's previous Source list", async () => {
    db.insert("list_sync_status", {
      list_id: listId,
      provider: "trakt",
      source_ref: "users/leo/lists/comedy",
      last_attempt_at: new Date(Date.now() - HOUR).toISOString(),
      last_success_at: new Date(Date.now() - HOUR).toISOString(),
      title_count: 9,
    });
    cache.seed(listId, [movie("tt0000001")], new Date(Date.now() - HOUR));
    useTrakt(
      vi.fn(() => Promise.reject(new SourceUnavailableError("private", "no"))),
    );

    await readList(config({ policy: "manual" })).catch(() => undefined);

    expect(await statusOf()).toMatchObject({
      sourceRef: "users/leo/lists/horror",
      problem: "private",
      lastSuccessAt: null,
      titleCount: null,
    });
  });
});

describe("the read after a new authorization", () => {
  it("does not join a read that started with the older Connection", async () => {
    seedConnection(accountId, "trakt");
    const watchlist = seedList(accountId, {
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    let release: (value: unknown) => void = () => undefined;
    const fetchSource = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      )
      .mockResolvedValue(entries("tt0000001"));
    useTrakt(fetchSource);
    const older = readList(
      config({ listId: watchlist.id, sourceRef: "me/watchlist" }),
    );
    await vi.waitFor(() => {
      expect(fetchSource).toHaveBeenCalledOnce();
    });

    await rereadConnectionLists(accountId, "trakt");

    // Both Trakt Lists were read again; the older read did not count.
    expect(fetchSource).toHaveBeenCalledTimes(3);
    expect(await statusOf(watchlist.id)).toMatchObject({
      problem: null,
      titleCount: 1,
    });
    // The older read ends last and must not undo the new one.
    release(entries());
    await older;
    expect(await statusOf(watchlist.id)).toMatchObject({
      problem: null,
      titleCount: 1,
    });
    expect(cache.get(watchlist.id)?.data.metas).toHaveLength(1);
  });

  it("does not record a late failure of the older read", async () => {
    seedConnection(accountId, "trakt");
    let fail: (error: unknown) => void = () => undefined;
    const fetchSource = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue(entries("tt0000001"));
    useTrakt(fetchSource);
    const older = readList(config()).catch(() => undefined);
    await vi.waitFor(() => {
      expect(fetchSource).toHaveBeenCalledOnce();
    });

    await rereadConnectionLists(accountId, "trakt");
    fail(new SourceUnavailableError("needs_connection", "old token"));
    await older;

    expect(await statusOf()).toMatchObject({ problem: null, titleCount: 1 });
  });
});

describe("Connections that need to be renewed", () => {
  beforeEach(() => {
    seedConnection(accountId, "trakt");
  });

  it("marks the Connection when the Provider refuses it", async () => {
    useTrakt(
      vi.fn(() =>
        Promise.reject(
          new SourceUnavailableError("needs_connection", "token refused"),
        ),
      ),
    );

    await readList(config()).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).toEqual(
      expect.any(String),
    );
    expect(await statusOf()).toMatchObject({ problem: "needs_connection" });
  });

  it("marks the Connection when its token cannot be refreshed", async () => {
    useTrakt(vi.fn(() => Promise.reject(new ConnectionExpiredError("trakt"))));

    await readList(config()).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).not.toBeNull();
  });

  it("does not mark the Connection for other failures", async () => {
    useTrakt(vi.fn(() => Promise.reject(new Error("timeout"))));

    await readList(config()).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).toBeNull();
  });

  it("clears the mark when a private Source list reads through the Connection again", async () => {
    const fetchSource = vi
      .fn()
      .mockRejectedValueOnce(new ConnectionExpiredError("trakt"))
      .mockResolvedValue(entries("tt0000001"));
    useTrakt(fetchSource);
    const watchlist = seedList(accountId, {
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    const read = config({ listId: watchlist.id, sourceRef: "me/watchlist" });

    await readList(read).catch(() => undefined);
    await readList(read);

    expect((await connectionOf())?.needsRenewalSince).toBeNull();
  });

  it("clears the mark after a private read whose Catalog could not be saved", async () => {
    vi.mocked(listCache.writeCachedList).mockRejectedValueOnce(
      new Error("R2 is down"),
    );
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));
    const watchlist = seedList(accountId, {
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    db.getTable("connections")[0].needs_renewal_since =
      new Date().toISOString();

    await readList(config({ listId: watchlist.id, sourceRef: "me/watchlist" }));

    expect((await connectionOf())?.needsRenewalSince).toBeNull();
    // The List status waits for a saved Catalog.
    expect(await statusOf(watchlist.id)).toBeUndefined();
  });

  it("keeps the mark when only a public Source list reads fine", async () => {
    const fetchSource = vi
      .fn()
      .mockRejectedValueOnce(new ConnectionExpiredError("trakt"))
      .mockResolvedValue(entries("tt0000001"));
    useTrakt(fetchSource);

    await readList(config()).catch(() => undefined);
    // Trakt reads a public list without the refused Connection.
    await readList(config());

    expect((await connectionOf())?.needsRenewalSince).not.toBeNull();
    expect(await statusOf()).toMatchObject({ problem: null, titleCount: 1 });
  });

  it("clears the mark when the user connects again", async () => {
    useTrakt(vi.fn(() => Promise.reject(new ConnectionExpiredError("trakt"))));
    await readList(config()).catch(() => undefined);

    await saveConnection(
      accountId,
      "trakt",
      { accessToken: "new", refreshToken: "new", expiresAt: null, scope: null },
      "leo",
      "https://api.stremlist.test/oauth/trakt/callback",
    );

    expect((await connectionOf())?.needsRenewalSince).toBeNull();
  });

  it("does not mark anything for a read without a Connection", async () => {
    useTrakt(
      vi.fn(() =>
        Promise.reject(new SourceUnavailableError("needs_connection", "no")),
      ),
    );

    await readList(config({ allowConnection: false })).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).toBeNull();
  });
});

describe("merged Lists", () => {
  const WATCHLIST = { provider: "trakt", sourceRef: "me/watchlist" } as const;
  let mergedId = "";
  let keys: { imdb: string; trakt: string } = { imdb: "", trakt: "" };

  beforeEach(async () => {
    mergedId = seedList(accountId, {
      provider: "imdb",
      source_ref: "ur1000001",
      position: 1,
      merged_sources: [
        { provider: WATCHLIST.provider, source_ref: WATCHLIST.sourceRef },
      ],
    }).id;
    const [list] = (await getAccountLists(accountId)).filter(
      (candidate) => candidate.id === mergedId,
    );
    const [imdb, trakt] = sourceCaches(list);
    keys = { imdb: imdb.cacheKey, trakt: trakt.cacheKey };
  });

  function mergedConfig(): TestRead {
    return config({
      listId: mergedId,
      provider: "imdb",
      sourceRef: "ur1000001",
      mergedSources: [WATCHLIST],
    });
  }

  async function snapshot() {
    return getListSyncStatuses(await getAccountLists(accountId));
  }

  it("record each Source list under the List, in the List's order", async () => {
    seedConnection(accountId, "trakt");
    useFakeProvider(
      fakeAdapter("imdb", {
        freshnessMs: 0,
        fetchSource: () =>
          Promise.resolve(entries("tt0000001", "tt0000002")) as never,
      }),
    );
    useTrakt(
      vi.fn(() =>
        Promise.reject(
          new SourceUnavailableError("needs_connection", "token refused"),
        ),
      ),
    );

    // The IMDb Source list still shows.
    await expect(readList(mergedConfig())).resolves.toMatchObject({
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
    const { syncStatus } = await snapshot();
    expect(syncStatus[mergedId]).toEqual([
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

    const { syncStatus } = await snapshot();

    expect(syncStatus[mergedId]).toEqual([
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
    cache.seed(keys.trakt, [movie("tt0000002")]);

    const { syncStatus } = await snapshot();

    expect(syncStatus[mergedId]).toEqual([
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
    const imdbRead = vi.fn(() => Promise.resolve(entries("tt0000009")));
    useFakeProvider(
      fakeAdapter("imdb", { freshnessMs: 0, fetchSource: imdbRead as never }),
    );
    const traktRead = vi.fn(() => Promise.resolve(entries("tt0000002")));
    useTrakt(traktRead);

    await rereadConnectionLists(accountId, "trakt");

    expect(imdbRead).not.toHaveBeenCalled();
    expect(traktRead).toHaveBeenCalledWith("me/watchlist", expect.anything());
    expect(cache.get(keys.trakt)?.data.metas).toHaveLength(1);
    expect((await snapshot()).syncStatus[mergedId][1]).toEqual(
      expect.objectContaining({ provider: "trakt", titleCount: 1 }),
    );
  });
});
