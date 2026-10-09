import { listSyncState } from "@stremlist/shared/sync-status";
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
} from "../../__tests__/helpers/mock-supabase";
import {
  ConnectionExpiredError,
  SourceUnavailableError,
} from "../../providers/types";
import { getAccountLists } from "../accounts";
import { listConnections, saveConnection } from "../connections";
import * as listCache from "../list-cache";
import type { ListFetchConfig } from "../lists";
import { getListCatalog, rereadConnectionLists } from "../lists";
import { getListSyncStatuses } from "../sync-status";

const HOUR = 60 * 60_000;

let accountId = "";
let listId = "";

function config(overrides: Partial<ListFetchConfig> = {}): ListFetchConfig {
  return {
    accountId,
    listId,
    provider: "trakt",
    sourceRef: "users/leo/lists/horror",
    sort: { by: "added_at", order: "asc" },
    allowConnection: true,
    skipAccountTimestamp: true,
    forceFresh: true,
    ...overrides,
  };
}

function useTrakt(fetchSource: ReturnType<typeof vi.fn>) {
  useFakeProvider(
    fakeAdapter("trakt", {
      fetchSource: fetchSource as never,
    }),
  );
}

function entries(...ids: string[]) {
  return { entries: ids.map((id) => ({ imdbId: id, meta: movie(id) })) };
}

async function statusOf(id = listId) {
  return (await getListSyncStatuses(await getAccountLists(accountId)))[id];
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

    await getListCatalog(config());

    expect(await statusOf()).toEqual({
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
    await getListCatalog(config());

    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    // Stremio still gets the cached Titles.
    await expect(getListCatalog(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    const status = await statusOf();
    expect(status).toMatchObject({
      lastSuccessAt: "2026-10-06T10:00:00.000Z",
      titleCount: 1,
      problem: "unavailable",
      failingSince: "2026-10-06T12:00:00.000Z",
    });
    expect(listSyncState(status, "none", false)).toMatchObject({
      kind: "failing",
      problem: "unavailable",
      olderTitlesFrom: "2026-10-06T10:00:00.000Z",
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

    await getListCatalog(config()).catch(() => undefined);
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"));
    await getListCatalog(config()).catch(() => undefined);

    expect(await statusOf()).toMatchObject({
      problem: "not_found",
      failingSince: "2026-10-06T10:00:00.000Z",
      lastAttemptAt: "2026-10-06T11:00:00.000Z",
      lastSuccessAt: null,
    });

    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    await getListCatalog(config());

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

    await getListCatalog(config()).catch(() => undefined);

    expect(fetchSource).not.toHaveBeenCalled();
    expect(await statusOf()).toMatchObject({ problem: "disabled" });
  });

  it("records one outcome for concurrent reads of the same List", async () => {
    const record = vi.fn(() => ({ data: true, error: null }));
    rpcHandlers.set("record_list_refresh", record);
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));

    await Promise.all([getListCatalog(config()), getListCatalog(config())]);

    expect(record).toHaveBeenCalledOnce();
  });

  it("still serves the Catalog when the status cannot be written", async () => {
    rpcHandlers.set("record_list_refresh", () => ({
      data: null,
      error: { message: "database is down" },
    }));
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));

    await expect(getListCatalog(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });
  });

  it("does not report an update whose Catalog could not be saved", async () => {
    vi.mocked(listCache.writeCachedList).mockRejectedValueOnce(
      new Error("R2 is down"),
    );
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));

    // This request still gets the Titles it read.
    await expect(getListCatalog(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    expect(db.getTable("list_sync_status")).toEqual([]);
  });

  it("ignores the status of a Source list that the List no longer reads", async () => {
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));
    await getListCatalog(config());

    const [list] = await getAccountLists(accountId);
    const statuses = await getListSyncStatuses([
      { ...list, sourceRef: "users/leo/lists/comedy" },
    ]);

    expect(statuses).toEqual({});
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
    const from = vi.spyOn(
      (await import("../../__tests__/helpers/mock-supabase")).supabase,
      "from",
    );
    from.mockReturnValueOnce({
      select: () => ({
        in: () => Promise.resolve({ data: null, error: { message: "down" } }),
      }),
    } as never);

    expect((await getListSyncStatuses(lists))[listId]).toMatchObject({
      problem: null,
      titleCount: 1,
    });
  });

  it("keep their cached last refresh when their first recorded refresh fails", async () => {
    const cachedAt = new Date(Date.now() - 2 * HOUR);
    cache.seed(listId, [movie("tt0000001"), movie("tt0000002")], cachedAt);
    useTrakt(vi.fn(() => Promise.reject(new Error("socket hang up"))));

    // Stremio still gets the cached Titles.
    await expect(getListCatalog(config())).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }, { id: "tt0000002" }],
    });

    const status = await statusOf();
    expect(status).toMatchObject({
      problem: "unavailable",
      titleCount: 2,
      lastSuccessAt: cachedAt.toISOString(),
    });
    expect(listSyncState(status, "none", false)).toMatchObject({
      kind: "failing",
      olderTitlesFrom: cachedAt.toISOString(),
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

    await getListCatalog(config({ noCacheFallback: true })).catch(
      () => undefined,
    );

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
    const older = getListCatalog(
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
    const older = getListCatalog(config()).catch(() => undefined);
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

    await getListCatalog(config()).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).toEqual(
      expect.any(String),
    );
    expect(await statusOf()).toMatchObject({ problem: "needs_connection" });
  });

  it("marks the Connection when its token cannot be refreshed", async () => {
    useTrakt(vi.fn(() => Promise.reject(new ConnectionExpiredError("trakt"))));

    await getListCatalog(config()).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).not.toBeNull();
  });

  it("does not mark the Connection for other failures", async () => {
    useTrakt(vi.fn(() => Promise.reject(new Error("timeout"))));

    await getListCatalog(config()).catch(() => undefined);

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

    await getListCatalog(read).catch(() => undefined);
    await getListCatalog(read);

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

    await getListCatalog(
      config({ listId: watchlist.id, sourceRef: "me/watchlist" }),
    );

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

    await getListCatalog(config()).catch(() => undefined);
    // Trakt reads a public list without the refused Connection.
    await getListCatalog(config());

    expect((await connectionOf())?.needsRenewalSince).not.toBeNull();
    expect(await statusOf()).toMatchObject({ problem: null, titleCount: 1 });
  });

  it("clears the mark when the user connects again", async () => {
    useTrakt(vi.fn(() => Promise.reject(new ConnectionExpiredError("trakt"))));
    await getListCatalog(config()).catch(() => undefined);

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

    await getListCatalog(config({ allowConnection: false })).catch(
      () => undefined,
    );

    expect((await connectionOf())?.needsRenewalSince).toBeNull();
  });
});
