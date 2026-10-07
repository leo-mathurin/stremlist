import type { ListSyncStatus } from "@stremlist/shared/sync-status";
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
import { refreshProviderLists } from "../list-prewarm";
import type { ListFetchConfig } from "../lists";
import { getListCatalog } from "../lists";
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
      showsOlderTitles: true,
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

  it("records nothing for a List removed while it was read", async () => {
    useTrakt(vi.fn(() => Promise.resolve(entries("tt0000001"))));
    db.tables.lists = [];

    await getListCatalog(config());

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
      showsOlderTitles: true,
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

  it("prefer the recorded status over the cache", async () => {
    cache.seed(listId, [movie("tt0000001")]);
    useTrakt(
      vi.fn(() => Promise.reject(new SourceUnavailableError("private", "no"))),
    );
    await getListCatalog(config({ noCacheFallback: true })).catch(
      () => undefined,
    );

    expect(await statusOf()).toMatchObject({ problem: "private" });
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

    await refreshProviderLists(accountId, "trakt");

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

    await refreshProviderLists(accountId, "trakt");
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

  it("keeps the first time the Provider refused the Connection", async () => {
    useTrakt(vi.fn(() => Promise.reject(new ConnectionExpiredError("trakt"))));
    vi.useFakeTimers({
      now: new Date("2026-10-06T10:00:00Z"),
      toFake: ["Date"],
    });
    await getListCatalog(config()).catch(() => undefined);
    vi.setSystemTime(new Date(Date.now() + HOUR));
    await getListCatalog(config()).catch(() => undefined);

    expect((await connectionOf())?.needsRenewalSince).toBe(
      "2026-10-06T10:00:00.000Z",
    );
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

describe("listSyncState", () => {
  const ok: ListSyncStatus = {
    sourceRef: "me/watchlist",
    lastAttemptAt: "2026-10-06T12:00:00.000Z",
    lastSuccessAt: "2026-10-06T12:00:00.000Z",
    titleCount: 42,
    problem: null,
    failingSince: null,
  };
  const failing = (
    problem: ListSyncStatus["problem"],
    overrides: Partial<ListSyncStatus> = {},
  ): ListSyncStatus => ({
    ...ok,
    lastAttemptAt: "2026-10-06T13:00:00.000Z",
    problem,
    failingSince: "2026-10-06T13:00:00.000Z",
    ...overrides,
  });

  it("waits for the first refresh of a new List", () => {
    expect(listSyncState(undefined, "none", false)).toEqual({
      kind: "waiting",
      reconnected: false,
    });
  });

  it("shows when the last successful refresh happened", () => {
    expect(listSyncState(ok, "none", false)).toEqual({
      kind: "synced",
      at: ok.lastSuccessAt,
      titleCount: 42,
    });
  });

  it("explains a failure and whether Stremio still shows older Titles", () => {
    expect(listSyncState(failing("private"), "none", false)).toEqual({
      kind: "failing",
      problem: "private",
      since: "2026-10-06T13:00:00.000Z",
      lastSuccessAt: ok.lastSuccessAt,
      showsOlderTitles: true,
    });
    expect(
      listSyncState(
        failing("not_found", { lastSuccessAt: null, titleCount: null }),
        "none",
        false,
      ),
    ).toMatchObject({ kind: "failing", showsOlderTitles: false });
    expect(
      listSyncState(failing("unavailable", { titleCount: 0 }), "none", false),
    ).toMatchObject({ showsOlderTitles: false });
  });

  it("asks to connect a List that needs a missing Connection", () => {
    expect(listSyncState(undefined, "none", true)).toEqual({
      kind: "connection",
      renew: false,
      stillShown: false,
    });
    expect(listSyncState(ok, "none", true)).toEqual({
      kind: "connection",
      renew: false,
      stillShown: false,
    });
  });

  it("asks to renew a refused Connection", () => {
    // Even before the List's own next read fails: Stremio still serves its
    // cached Titles until then.
    expect(listSyncState(ok, "renew", true)).toEqual({
      kind: "connection",
      renew: true,
      stillShown: true,
    });
    // A Source list whose read the Provider refused shows nothing.
    expect(listSyncState(failing("needs_connection"), "renew", false)).toEqual({
      kind: "connection",
      renew: true,
      stillShown: false,
    });
    expect(listSyncState(undefined, "renew", true)).toEqual({
      kind: "connection",
      renew: true,
      stillShown: false,
    });
  });

  it("keeps a public List synced while another List's Connection is refused", () => {
    expect(listSyncState(ok, "renew", false)).toMatchObject({
      kind: "synced",
    });
  });

  it("waits for the read after a new Connection", () => {
    expect(listSyncState(failing("needs_connection"), "ok", true)).toEqual({
      kind: "waiting",
      reconnected: true,
    });
  });

  it("does not claim older Titles for a List that lost its Connection", () => {
    expect(
      listSyncState(failing("needs_connection"), "none", false),
    ).toMatchObject({ kind: "failing", showsOlderTitles: false });
  });
});
