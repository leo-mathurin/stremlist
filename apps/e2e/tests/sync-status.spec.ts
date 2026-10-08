import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { FRONTEND_URL } from "../env.js";
import { getConfig, getSyncStatus, refresh } from "../helpers/api.js";
import {
  clearRefreshCooldown,
  getConnectionRenewal,
  getSyncStatusRows,
  resetDb,
  seedAccount,
  seedAccountWithLists,
  seedConnection,
  seedList,
  seedSyncStatus,
} from "../helpers/db.js";
import { seedCachedCatalog } from "../helpers/r2.js";
import { CATALOG_FIXTURE_USER } from "../helpers/test-data.js";

// The sync status of each List (STR-58) against the real backend, database
// and cache. The test backend has no Trakt client ID, so every Trakt read
// fails as "Trakt is temporarily unavailable", and a Trakt token cannot be
// refreshed: both are deterministic, offline failures.

const HOUR = 60 * 60_000;
const PUBLIC_TRAKT_LIST = "users/fixture/lists/horror";

const configureUrl = (accountKey: string) =>
  `${FRONTEND_URL}/configure?account=${accountKey}`;

function meta(id: string) {
  return {
    id,
    name: `QA Sync ${id}`,
    type: "movie" as const,
    poster: null,
    posterShape: "poster" as const,
    description: "Controlled sync status fixture",
    genres: ["Drama"],
  };
}

async function open(page: Page, accountKey: string, title: string) {
  await page.goto(configureUrl(accountKey));
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

test.beforeEach(async () => {
  await resetDb();
});

test(
  "a failed refresh keeps the last success, and the page explains it after a reload",
  { tag: "@local" },
  async ({ page }) => {
    const {
      accountId,
      listIds: [listId],
    } = await seedAccountWithLists([
      {
        provider: "trakt",
        sourceRef: PUBLIC_TRAKT_LIST,
        catalogTitle: "Horror nights",
        displayMode: "split",
      },
    ]);
    const lastSuccess = new Date(Date.now() - HOUR);
    await seedSyncStatus(listId, {
      provider: "trakt",
      sourceRef: PUBLIC_TRAKT_LIST,
      lastAttemptAt: lastSuccess,
      lastSuccessAt: lastSuccess,
      titleCount: 2,
    });
    await seedCachedCatalog(listId, [meta("tt9910001"), meta("tt9910002")]);
    await clearRefreshCooldown(accountId);

    const { body } = await refresh(accountId);
    expect(body).toMatchObject({ refreshed: 0, failed: 1, total: 1 });

    const [row] = await getSyncStatusRows(listId);
    expect(row).toMatchObject({
      provider: "trakt",
      source_ref: PUBLIC_TRAKT_LIST,
      failure_reason: "disabled",
      title_count: 2,
    });
    expect(new Date(row.last_success_at!).getTime()).toBe(
      lastSuccess.getTime(),
    );
    expect(new Date(row.failing_since!).getTime()).toBeGreaterThan(
      lastSuccess.getTime(),
    );
    expect(row.last_attempt_at).toBe(row.failing_since);

    const notice =
      "Trakt is temporarily unavailable. Please try again later. Stremio shows the titles from the last refresh, 1 hour ago.";
    await open(page, accountId, "Horror nights");
    await expect(
      page.getByText("Refresh failed · titles from 1 hour ago", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    await expect(
      page.getByText("1 List needs attention", { exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
  },
);

test(
  "a Connection the Provider refuses is marked, and public Lists do not fail with it",
  { tag: "@local" },
  async ({ page }) => {
    const {
      accountId,
      listIds: [watchlistId, publicId],
    } = await seedAccountWithLists([
      {
        provider: "trakt",
        sourceRef: "me/watchlist",
        catalogTitle: "Trakt Watchlist",
        displayMode: "split",
      },
      {
        provider: "trakt",
        sourceRef: PUBLIC_TRAKT_LIST,
        catalogTitle: "Horror nights",
        displayMode: "split",
      },
    ]);
    // An expired token whose refresh cannot work: the Connection is refused.
    await seedConnection(accountId, "trakt", {
      expiresAt: new Date(Date.now() - HOUR),
    });
    await clearRefreshCooldown(accountId);
    expect(await getConnectionRenewal(accountId, "trakt")).toBeNull();

    await refresh(accountId);

    expect(await getConnectionRenewal(accountId, "trakt")).not.toBeNull();
    expect(await getSyncStatusRows(watchlistId)).toMatchObject([
      { failure_reason: "needs_connection", last_success_at: null },
    ]);
    // The public List reads without the refused Connection (it then fails
    // only because the test backend has no Trakt client ID).
    expect(await getSyncStatusRows(publicId)).toMatchObject([
      { failure_reason: "disabled" },
    ]);
    const { body } = await getConfig(accountId);
    expect(body.connections).toEqual([
      expect.objectContaining({
        provider: "trakt",
        needsRenewalSince: expect.any(String),
      }),
    ]);

    await open(page, accountId, "Trakt Watchlist");
    const renew =
      "Trakt refused the Stremlist Connection, so this List does not show in Stremio. Connect Trakt again to renew it.";
    await expect(
      page.getByText("Needs renewal", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Connection needs to be renewed", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(renew, { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Trakt is temporarily unavailable. Please try again later. This problem started just now.",
        { exact: true },
      ),
    ).toBeVisible();
    // The test backend cannot start a Trakt authorization (no client ID),
    // so the page offers no Connect button; the toolkit covers that click.
    await expect(
      page.getByRole("button", { name: /^Connect again/ }),
    ).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(renew, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Needs renewal", { exact: true }),
    ).toBeVisible();
  },
);

test(
  "a Legacy alias sees the sync status of its public Lists only",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount({
      legacyImdbUserId: CATALOG_FIXTURE_USER,
    });
    const watchlistId = await seedList(accountId, {
      sourceRef: CATALOG_FIXTURE_USER,
      catalogTitle: "",
      position: 0,
    });
    const historyId = await seedList(accountId, {
      provider: "trakt",
      sourceRef: "me/history",
      catalogTitle: "Trakt History",
      position: 1,
    });
    await seedConnection(accountId, "trakt");
    const at = new Date(Date.now() - HOUR);
    for (const [listId, provider, sourceRef] of [
      [watchlistId, "imdb", CATALOG_FIXTURE_USER],
      [historyId, "trakt", "me/history"],
    ] as const) {
      await seedSyncStatus(listId, {
        provider,
        sourceRef,
        lastAttemptAt: at,
        lastSuccessAt: at,
        titleCount: 4,
      });
    }

    const { status, body } = await getSyncStatus(CATALOG_FIXTURE_USER);

    expect(status).toBe(200);
    expect(Object.keys(body.syncStatus)).toEqual([watchlistId]);
    expect(body.syncStatus[watchlistId]).toMatchObject({
      sourceRef: CATALOG_FIXTURE_USER,
      titleCount: 4,
      problem: null,
    });
    expect(body.connections).toEqual([]);
  },
);

test(
  "a List cached before sync statuses existed shows its last refresh from the cache",
  { tag: "@local" },
  async ({ page }) => {
    const {
      accountId,
      listIds: [listId],
    } = await seedAccountWithLists([
      {
        sourceRef: CATALOG_FIXTURE_USER,
        catalogTitle: "Cached watchlist",
        displayMode: "split",
      },
    ]);
    await seedCachedCatalog(listId, [
      meta("tt9910001"),
      meta("tt9910002"),
      meta("tt9910003"),
    ]);

    const { body } = await getSyncStatus(accountId);
    expect(body.syncStatus[listId]).toMatchObject({
      sourceRef: CATALOG_FIXTURE_USER,
      titleCount: 3,
      problem: null,
    });
    expect(await getSyncStatusRows(listId)).toEqual([]);

    await open(page, accountId, "Cached watchlist");
    await expect(page.getByText(/^Updated .+ · 3 titles$/)).toBeVisible();
    await expect(page.getByText(/needs? attention/)).toHaveCount(0);
  },
);

test(
  "a List added on the page records its first refresh, and the page shows it without a reload",
  { tag: "@live-regression" },
  async ({ page }) => {
    const {
      accountId,
      listIds: [listId],
    } = await seedAccountWithLists([
      {
        sourceRef: CATALOG_FIXTURE_USER,
        catalogTitle: "Cached watchlist",
        displayMode: "split",
      },
    ]);
    await seedCachedCatalog(listId, [meta("tt9910001")]);
    await open(page, accountId, "Cached watchlist");

    await page.getByRole("button", { name: "Add an IMDb chart" }).click();
    await page.getByRole("menuitem", { name: /^Top 250 Movies/ }).click();
    await expect(
      page.getByText("Not saved yet", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // The save prewarms the new List against live IMDb; the page polls.
    const updated = page.getByText(/^Updated .+ · 250 titles$/);
    await expect(updated).toBeVisible({ timeout: 60_000 });
    const { body } = await getConfig(accountId);
    const chart = body.lists.find(
      (list) => list.sourceRef === "imdb:top-rated-movies",
    );
    expect(chart).toBeDefined();
    expect(await getSyncStatusRows(chart!.id)).toMatchObject([
      { failure_reason: null, title_count: 250 },
    ]);

    await page.reload();
    await expect(updated).toBeVisible();
  },
);
