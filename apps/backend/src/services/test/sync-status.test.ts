import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  movie,
  seedAccount,
  seedConnection,
  seedList,
} from "../../test/helpers/account.fixture";
import { cache } from "../../test/helpers/list-cache.test-utils";
import {
  cinemetaWithoutTitles,
  FakeImdb,
} from "../../test/helpers/imdb.test-utils";
import {
  db,
  resetRpc,
  rpcCallsOf,
  rpcHandlers,
} from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { resetR2 } from "../../test/helpers/r2.test-utils";
import {
  FakeTrakt,
  traktItems,
  useTraktApp,
} from "../../test/helpers/trakt.test-utils";
import { TRAKT_API, TRAKT_AUTH } from "../../providers/trakt/api";
import { getAccountLists } from "../accounts";
import { listConnections, saveConnection } from "../connections";
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

const HORROR = "/users/leo/lists/horror/items";
const WATCHLIST_PATH = "/users/me/watchlist";
const HORROR_ITEMS = `${TRAKT_API}${HORROR}`;
const WATCHLIST_ITEMS = `${TRAKT_API}${WATCHLIST_PATH}`;
const TOKEN_URL = `${TRAKT_AUTH}/oauth/token`;

const imdb = new FakeImdb();
const trakt = new FakeTrakt();
const server = useMswServer();

function traktList(...ids: string[]) {
  return HttpResponse.json(traktItems(ids.map((id) => movie(id))));
}

function traktStatus(status: number) {
  return new HttpResponse(null, { status });
}

function refusedRefresh() {
  return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
}

function expireConnection() {
  db.getTable("connections")[0].expires_at = new Date(0).toISOString();
}

interface TestRead extends ListRead {
  listId: string;
  provider: ProviderId;
  sourceRef: string;
  mergedSources?: ListSource[];
}

function read(overrides: Partial<TestRead> = {}) {
  const fields: TestRead = {
    accountId,
    listId,
    provider: "trakt",
    sourceRef: "users/leo/lists/horror",
    sort: { by: "added_at", order: "asc" },
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

function serving(path: string, ...ids: string[]) {
  const metas = ids.map((id) => movie(id));
  for (const meta of metas) imdb.titles.set(meta.id, meta);
  trakt.serve(path, metas);
}

function failing(path: string) {
  server.use(http.get(`${TRAKT_API}${path}`, () => HttpResponse.error()));
}

function seedWatchlist() {
  return seedList(accountId, {
    provider: "trakt",
    source_ref: "me/watchlist",
    position: 1,
  }).id;
}

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

let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 24 * HOUR;
  vi.setSystemTime(clock);
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  trakt.reset();
  accountId = seedAccount().id;
  listId = seedList(accountId, {
    provider: "trakt",
    source_ref: "users/leo/lists/horror",
  }).id;
  imdb.reset();
  imdb.titles.set("tt0000001", movie("tt0000001"));
  server.use(imdb.handler, trakt.handler, cinemetaWithoutTitles);
  useTraktApp();
});

afterEach(() => {
  clock = Date.now();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("recording refreshes", () => {
  it("stores the time and Title count of a successful refresh", async () => {
    serving(HORROR, "tt0000001", "tt0000002");

    await read();

    const anyTime: unknown = expect.any(String);
    expect(await statusOf()).toEqual({
      provider: "trakt",
      sourceRef: "users/leo/lists/horror",
      lastAttemptAt: anyTime,
      lastSuccessAt: anyTime,
      titleCount: 2,
      problem: null,
      failingSince: null,
    });
  });

  it("keeps the last success when a refresh fails and the cache still serves", async () => {
    server.use(
      http.get(HORROR_ITEMS, () => traktList("tt0000001"), { once: true }),
      http.get(HORROR_ITEMS, () => HttpResponse.error()),
    );
    const start = Date.now();
    await read();

    vi.setSystemTime(start + 7 * HOUR);
    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    expect(await statusOf()).toMatchObject({
      lastSuccessAt: new Date(start).toISOString(),
      titleCount: 1,
      problem: "unavailable",
      failingSince: new Date(start + 7 * HOUR).toISOString(),
    });
  });

  it("keeps the start of a failure run and ends it on the next success", async () => {
    server.use(
      http.get(HORROR_ITEMS, () => traktStatus(401), { once: true }),
      http.get(HORROR_ITEMS, () => traktStatus(404), { once: true }),
      http.get(HORROR_ITEMS, () => traktList()),
    );
    const start = Date.now();

    await tryRead();
    vi.setSystemTime(start + HOUR);
    await tryRead();

    expect(await statusOf()).toMatchObject({
      problem: "not_found",
      failingSince: new Date(start).toISOString(),
      lastAttemptAt: new Date(start + HOUR).toISOString(),
      lastSuccessAt: null,
    });

    vi.setSystemTime(start + 2 * HOUR);
    await read();

    expect(await statusOf()).toMatchObject({
      problem: null,
      failingSince: null,
      titleCount: 0,
      lastSuccessAt: new Date(start + 2 * HOUR).toISOString(),
    });
  });

  it("records a turned-off Provider without reading it", async () => {
    serving(HORROR, "tt0000001");
    vi.stubEnv("DISABLED_PROVIDERS", "trakt");

    await tryRead();

    expect(trakt.requests).toEqual([]);
    expect(await statusOf()).toMatchObject({ problem: "disabled" });
  });

  it("records one outcome for concurrent reads of the same List", async () => {
    serving(HORROR, "tt0000001");

    await Promise.all([read(), read()]);

    expect(rpcCallsOf("record_list_refresh")).toHaveLength(1);
  });

  it("still serves the Catalog when the status cannot be written", async () => {
    rpcHandlers.set("record_list_refresh", () => ({
      data: null,
      error: { message: "database is down" },
    }));
    serving(HORROR, "tt0000001");

    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });
  });

  it("does not report an update whose Catalog could not be saved", async () => {
    cache.unwritable.add(listId);
    serving(HORROR, "tt0000001");

    await expect(read()).resolves.toMatchObject({
      metas: [{ id: "tt0000001" }],
    });

    expect(db.getTable("list_sync_status")).toEqual([]);
  });

  it("ignores the status of a Source list that the List no longer reads", async () => {
    serving(HORROR, "tt0000001");
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
    db.unavailableTables.add("list_sync_status");

    expect((await getListSyncStatuses(lists)).syncStatus[listId]).toEqual([
      expect.objectContaining({ problem: null, titleCount: 1 }),
    ]);
  });

  it("keep their cached last refresh when their first recorded refresh fails", async () => {
    const cachedAt = new Date(Date.now() - 7 * HOUR);
    cache.seed(listId, [movie("tt0000001"), movie("tt0000002")], cachedAt);
    failing(HORROR);

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
    trakt.fail(HORROR, 401);

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
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    let reads = 0;
    server.use(
      http.get(
        WATCHLIST_ITEMS,
        async () => {
          reads += 1;
          started.resolve();
          await first.promise;
          return traktList();
        },
        { once: true },
      ),
      http.get(HORROR_ITEMS, () => {
        reads += 1;
        return traktList("tt0000001");
      }),
      http.get(WATCHLIST_ITEMS, () => {
        reads += 1;
        return traktList("tt0000001");
      }),
    );
    const older = read({ listId: watchlistId, ...WATCHLIST_READ });
    await started.promise;

    await rereadConnectionLists(accountId, "trakt");

    expect(reads).toBe(3);
    const expected = { problem: null, titleCount: 1 };
    expect(await statusOf(watchlistId)).toMatchObject(expected);
    first.resolve();
    await older;
    expect(await statusOf(watchlistId)).toMatchObject(expected);
    expect(cache.get(watchlistId)?.data.metas).toHaveLength(1);
  });

  it("does not record a late failure of the older read", async () => {
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    server.use(
      http.get(
        HORROR_ITEMS,
        async () => {
          started.resolve();
          await first.promise;
          return traktStatus(401);
        },
        { once: true },
      ),
      http.get(HORROR_ITEMS, ({ request }) =>
        request.headers.has("Authorization")
          ? traktList("tt0000001")
          : traktStatus(401),
      ),
    );
    const older = tryRead();
    await started.promise;

    await rereadConnectionLists(accountId, "trakt");
    first.resolve();
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
      () => trakt.fail(WATCHLIST_PATH, 401),
      {},
      true,
      "needs_connection",
    ],
    [
      "marks the Connection when its token cannot be refreshed",
      () => {
        expireConnection();
        server.use(http.post(TOKEN_URL, refusedRefresh));
        serving(WATCHLIST_PATH, "tt0000001");
      },
      {},
      true,
      "needs_connection",
    ],
    [
      "does not mark the Connection for other failures",
      () => failing(WATCHLIST_PATH),
      {},
      false,
      "unavailable",
    ],
    [
      "does not mark anything for a read without a Connection",
      () => serving(WATCHLIST_PATH, "tt0000001"),
      { allowConnection: false },
      false,
      "needs_connection",
    ],
  ])("%s", async (_, prepare, overrides, marked, problem) => {
    prepare();
    const watchlist = { listId: seedWatchlist(), ...WATCHLIST_READ };

    await tryRead({ ...watchlist, ...overrides });

    expect(await needsRenewalSince()).toEqual(
      marked ? expect.any(String) : null,
    );
    expect(await statusOf(watchlist.listId)).toMatchObject({ problem });
  });

  it("clears the mark when a private Source list reads through the Connection again", async () => {
    expireConnection();
    server.use(
      http.post(TOKEN_URL, refusedRefresh, { once: true }),
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: "renewed", expires_in: 3600 }),
      ),
      http.get(WATCHLIST_ITEMS, () => traktList("tt0000001")),
    );
    const watchlist = { listId: seedWatchlist(), ...WATCHLIST_READ };

    await tryRead(watchlist);
    await read(watchlist);

    expect(await needsRenewalSince()).toBeNull();
  });

  it("clears the mark after a private read whose Catalog could not be saved", async () => {
    serving(WATCHLIST_PATH, "tt0000001");
    const watchlistId = seedWatchlist();
    cache.unwritable.add(watchlistId);
    db.getTable("connections")[0].needs_renewal_since =
      new Date().toISOString();

    await read({ listId: watchlistId, ...WATCHLIST_READ });

    expect(await needsRenewalSince()).toBeNull();
    expect(await statusOf(watchlistId)).toBeUndefined();
  });

  it("keeps the mark when only a public Source list reads fine", async () => {
    expireConnection();
    server.use(
      http.post(TOKEN_URL, refusedRefresh),
      http.get(HORROR_ITEMS, () => traktList("tt0000001")),
    );

    await tryRead();
    await read();

    expect(await needsRenewalSince()).not.toBeNull();
    expect(await statusOf()).toMatchObject({ problem: null, titleCount: 1 });
  });

  it("clears the mark when the user connects again", async () => {
    expireConnection();
    server.use(http.post(TOKEN_URL, refusedRefresh));
    serving(WATCHLIST_PATH, "tt0000001");
    await tryRead({ listId: seedWatchlist(), ...WATCHLIST_READ });
    expect(await needsRenewalSince()).toEqual(expect.any(String));

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
    imdb.watchlists.set("ur1000001", [movie("tt0000001"), movie("tt0000002")]);
    imdb.titles.set("tt0000002", movie("tt0000002"));
    trakt.fail(WATCHLIST_PATH, 401);

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
    seedConnection(accountId, "trakt", { accessToken: "leo-token" });
    const revoked: unknown[] = [];
    server.use(
      http.post("https://auth.trakt.tv/oauth/revoke", async ({ request }) => {
        revoked.push(await request.json());
        return HttpResponse.json({});
      }),
    );

    await disconnectProvider(accountId, "trakt");

    expect(revoked).toEqual([expect.objectContaining({ token: "leo-token" })]);
    expect(cache.get(keys.imdb)).not.toBeNull();
    expect(cache.get(keys.trakt)).toBeNull();
    expect(db.getTable("list_sync_status").map((row) => row.provider)).toEqual([
      "imdb",
    ]);
  });

  it("read the merged Source lists of a new Connection again, in their own cache", async () => {
    seedConnection(accountId, "trakt", { accessToken: "leo-token" });
    imdb.watchlists.set("ur1000001", [movie("tt0000009")]);
    serving(WATCHLIST_PATH, "tt0000002");
    serving(HORROR, "tt0000002");

    await rereadConnectionLists(accountId, "trakt");

    expect(imdb.requestsOf("WatchListPage")).toEqual([]);
    expect(
      trakt.requestsOf(WATCHLIST_PATH).map((request) => request.token),
    ).toEqual(["leo-token"]);
    expect(cache.get(keys.trakt)?.data.metas).toHaveLength(1);
    expect((await mergedStatus())[1]).toEqual(
      expect.objectContaining({ provider: "trakt", titleCount: 1 }),
    );
  });
});
