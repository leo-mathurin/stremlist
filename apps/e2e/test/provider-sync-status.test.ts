import { expect, test } from "@playwright/test";
import {
  getConnectionRow,
  getSyncStatusRows,
  resetDb,
  seedAccount,
  seedConnection,
  seedList,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";

let backend: FixtureBackend;

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider.fixture.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
});

const REFUSED_TRAKT = {
  expiresAt: new Date(Date.now() - 60_000),
  refreshToken: "rejected-refresh",
};

const TRAKT_WATCHLIST = {
  provider: "trakt",
  sourceRef: "me/watchlist",
  catalogTitle: "Trakt Watchlist",
  position: 0,
  displayMode: "split",
} as const;

const NEEDS_RENEWAL = expect.objectContaining({
  provider: "trakt",
  needsRenewalSince: expect.any(String),
});

const renewalMark = async (accountId: string) =>
  (await getConnectionRow(accountId, "trakt"))?.needs_renewal_since;
const syncStatus = async (accountId: string) =>
  (await backend.api.getSyncStatus(accountId)).body;
const watchlistReads = () =>
  backend.requests((url) => url.pathname === "/users/me/watchlist");

test(
  "a Catalog preview reads through the Connection of its own Account only",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const owner = await seedAccount();
    await seedConnection(owner, "trakt");
    const other = await seedAccount();
    const preview = (accountKey?: string, sortOption = "added_at-asc") =>
      api.previewList({
        accountKey,
        provider: "trakt",
        sourceRef: "me/watchlist",
        sortOption,
        displayMode: "split",
      });

    const own = await preview(owner);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      ok: true,
      titleCount: 2,
      catalogs: [
        {
          type: "movie",
          preset: null,
          total: 1,
          titles: [{ id: "tt0111161", name: "The Shawshank Redemption" }],
        },
        {
          type: "series",
          preset: null,
          total: 1,
          titles: [{ id: "tt0903747", name: "Breaking Bad" }],
        },
      ],
      unresolved: { count: 0 },
    });
    const firstReads = watchlistReads();
    expect(firstReads.length).toBeGreaterThan(0);
    expect(
      firstReads.every(
        (entry) => entry.authorization === "fixture-access-token",
      ),
    ).toBe(true);

    for (const key of [other, undefined]) {
      expect((await preview(key)).body).toEqual({
        ok: false,
        reason: "needs_connection",
      });
    }
    expect((await preview(owner, "title-asc")).body).toMatchObject({
      ok: true,
    });
    expect(watchlistReads()).toHaveLength(firstReads.length);

    expect((await api.disconnect(owner, "trakt")).status).toBe(200);
    expect((await preview(owner)).body).toEqual({
      ok: false,
      reason: "needs_connection",
    });
    expect(watchlistReads()).toHaveLength(firstReads.length);
  },
);

test(
  "a Catalog preview through a refused Connection marks it for renewal, but is not a refresh",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt", REFUSED_TRAKT);
    const listId = await seedList(accountId, TRAKT_WATCHLIST);

    const preview = await api.previewList({
      accountKey: accountId,
      provider: "trakt",
      sourceRef: "me/watchlist",
      sortOption: "added_at-asc",
      displayMode: "split",
    });
    expect(preview.body).toEqual({ ok: false, reason: "needs_connection" });

    expect(await renewalMark(accountId)).not.toBeNull();
    expect(await getSyncStatusRows(listId)).toEqual([]);
    expect(await syncStatus(accountId)).toEqual({
      syncStatus: { [listId]: [null] },
      connections: [NEEDS_RENEWAL],
      readQueue: {},
    });
  },
);

test(
  "a refused Connection is marked for renewal, and a new authorization clears the mark and reads its Lists again",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt", REFUSED_TRAKT);
    const listId = await seedList(accountId, TRAKT_WATCHLIST);

    expect(await api.listCatalogNames(accountId, listId, "movie")).toEqual([
      "⚠️ This watchlist needs your Trakt account",
    ]);
    expect(await renewalMark(accountId)).not.toBeNull();
    expect(await getSyncStatusRows(listId)).toMatchObject([
      {
        provider: "trakt",
        source_ref: "me/watchlist",
        failure_reason: "needs_connection",
        last_success_at: null,
        title_count: null,
      },
    ]);
    expect(await syncStatus(accountId)).toEqual({
      syncStatus: {
        [listId]: [
          expect.objectContaining({
            sourceRef: "me/watchlist",
            problem: "needs_connection",
            lastSuccessAt: null,
          }),
        ],
      },
      connections: [NEEDS_RENEWAL],
      readQueue: {},
    });

    const { callback, completion } = await backend.authorize(
      accountId,
      "trakt",
    );
    expect(callback.status).toBe(302);
    expect(completion.status).toBe(200);
    expect(await renewalMark(accountId)).toBeNull();

    await expect
      .poll(async () => (await syncStatus(accountId)).syncStatus[listId][0], {
        timeout: 15_000,
      })
      .toMatchObject({ problem: null, failingSince: null, titleCount: 2 });
    const [row] = await getSyncStatusRows(listId);
    expect(row.last_success_at).toBe(row.last_attempt_at);
    expect(watchlistReads().at(-1)?.authorization).toBe("fresh-access");
    expect((await syncStatus(accountId)).connections).toEqual([
      expect.objectContaining({ provider: "trakt", needsRenewalSince: null }),
    ]);
    expect(await api.listCatalogNames(accountId, listId, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
  },
);

test(
  "a working read clears a renewal mark, and a disconnect forgets the sync status of the Lists read through it",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt", {
      needsRenewalSince: new Date(Date.now() - 60_000),
    });
    const privateId = await seedList(accountId, TRAKT_WATCHLIST);
    const publicId = await seedList(accountId, {
      ...TRAKT_WATCHLIST,
      sourceRef: "users/fixture-user/watchlist",
      catalogTitle: "Shared watchlist",
      position: 1,
    });

    for (const listId of [privateId, publicId]) {
      expect(await api.listCatalogNames(accountId, listId, "movie")).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await getSyncStatusRows(listId)).toMatchObject([
        { failure_reason: null, title_count: 2, failing_since: null },
      ]);
    }
    expect(await renewalMark(accountId)).toBeNull();

    expect(await api.disconnect(accountId, "trakt")).toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(await getSyncStatusRows(privateId)).toEqual([]);
    expect(await getSyncStatusRows(publicId)).toHaveLength(1);
    const body = await syncStatus(accountId);
    expect(body.syncStatus).toEqual({
      [privateId]: [null],
      [publicId]: [expect.objectContaining({ problem: null })],
    });
    expect(body.connections).toEqual([]);
  },
);

test(
  "a merged List keeps the sync status of each Source list through a refused Connection, a new one and a disconnect",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt", REFUSED_TRAKT);
    const listId = await seedList(accountId, {
      provider: "trakt",
      sourceRef: "users/fixture-user/watchlist",
      catalogTitle: "Merged Trakt",
      position: 0,
      displayMode: "split",
      mergedSources: [{ provider: "trakt", sourceRef: "me/watchlist" }],
    });

    expect(await api.listCatalogNames(accountId, listId, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
    expect(await syncStatus(accountId)).toEqual({
      syncStatus: {
        [listId]: [
          expect.objectContaining({
            provider: "trakt",
            sourceRef: "users/fixture-user/watchlist",
            problem: null,
          }),
          expect.objectContaining({
            provider: "trakt",
            sourceRef: "me/watchlist",
            problem: "needs_connection",
          }),
        ],
      },
      connections: [NEEDS_RENEWAL],
      readQueue: {},
    });

    const { callback, completion } = await backend.authorize(
      accountId,
      "trakt",
    );
    expect(callback.status).toBe(302);
    expect(completion.status).toBe(200);
    await expect
      .poll(async () => (await syncStatus(accountId)).syncStatus[listId][1], {
        timeout: 15_000,
      })
      .toEqual(
        expect.objectContaining({
          sourceRef: "me/watchlist",
          problem: null,
          failingSince: null,
        }),
      );

    expect(await api.disconnect(accountId, "trakt")).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(
      (await getSyncStatusRows(listId)).map((row) => row.source_ref),
    ).toEqual(["users/fixture-user/watchlist"]);
    expect((await syncStatus(accountId)).syncStatus).toEqual({
      [listId]: [
        expect.objectContaining({ sourceRef: "users/fixture-user/watchlist" }),
        null,
      ],
    });
  },
);
