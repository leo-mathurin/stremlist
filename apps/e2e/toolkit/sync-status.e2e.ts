import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type { AccountConfigResponse } from "@stremlist/shared/stremio.types";
import {
  SAVED_REINSTALL,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  connected,
  row,
  syncedStatus,
  toJson,
} from "./config-fixture";

// The sync status of each List (STR-58): what each row says about its last
// refresh, and the Connections that need to be renewed. The API is
// intercepted; the Playwright spec `sync-status.spec.ts` checks the real
// recording.

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const ids = {
  synced: row.id,
  older: "00000000-0000-4000-8000-000000000002",
  missing: "00000000-0000-4000-8000-000000000003",
  waiting: "00000000-0000-4000-8000-000000000004",
  trakt: "00000000-0000-4000-8000-000000000005",
};

function list(
  id: string,
  sourceRef: string,
  catalogTitle: string,
  provider: "imdb" | "trakt" = "imdb",
) {
  return { ...row, id, provider, sourceRef, catalogTitle };
}

const traktWatchlist = list(
  ids.trakt,
  "me/watchlist",
  "Trakt Watchlist",
  "trakt",
);
const traktConnection = connected("trakt");

/** Answer `/sync-status` with `answer(poll)`; returns how often it was asked. */
async function routeSyncStatus(
  browser: Browser,
  answer: (poll: number) => object,
) {
  const polls: string[] = [];
  await browser.route(`${backend}/${accountId}/sync-status`, async (route) => {
    polls.push(route.request.method);
    await route.fulfill({ json: toJson(answer(polls.length)) });
  });
  return polls;
}

/** The Source lists of the Trakt Connection (Quick add asks for them). */
async function routeTraktSources(browser: Browser) {
  await browser.route(
    `${backend}/${accountId}/connections/trakt/sources`,
    async (route) => {
      await route.fulfill({ json: { sources: [] } });
    },
  );
}

/** Record starts of an authorization and end them on a fixture page. */
async function routeConnectStart(browser: Browser) {
  const starts: string[] = [];
  await browser.route(
    `${backend}/${accountId}/connections/trakt/start`,
    async (route) => {
      starts.push(route.request.method);
      await route.fulfill({
        json: { ok: true, authorizeUrl: `${backend}/authorize-fixture` },
      });
    },
  );
  await browser.route(`${backend}/authorize-fixture`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<h1>Trakt authorization fixture</h1>",
    });
  });
  return starts;
}

test("each List shows its last refresh or why it failed, and a new List is polled until it refreshes", async ({
  app,
  browser,
  screen,
}) => {
  const synced = syncedStatus(row.sourceRef, 12, ago(5 * MINUTE));
  const older = {
    sourceRef: "imdb:most-popular-tv",
    lastAttemptAt: ago(5 * MINUTE),
    lastSuccessAt: ago(3 * 60 * MINUTE),
    titleCount: 100,
    problem: "unavailable",
    failingSince: ago(40 * MINUTE),
  };
  const missing = {
    sourceRef: "ur99000017",
    lastAttemptAt: ago(MINUTE),
    lastSuccessAt: null,
    titleCount: null,
    problem: "not_found",
    failingSince: ago(2 * 24 * 60 * MINUTE),
  };
  const statuses = {
    [ids.synced]: synced,
    [ids.older]: older,
    [ids.missing]: missing,
  };
  await captureConfig(browser, {
    ...configuration,
    lists: [
      row,
      list(ids.older, older.sourceRef, "Popular series"),
      list(ids.missing, missing.sourceRef, "Friend watchlist"),
      list(ids.waiting, "imdb:box-office", "Box office"),
    ],
    syncStatus: statuses,
  } as AccountConfigResponse);
  const polls = await routeSyncStatus(browser, (poll) => ({
    syncStatus:
      poll < 2
        ? statuses
        : {
            ...statuses,
            [ids.waiting]: syncedStatus("imdb:box-office", 10, ago(0)),
          },
    connections: [],
  }));

  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByText("Updated 5 minutes ago · 12 titles", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Refresh failed · titles from 3 hours ago", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "IMDb did not answer. Please try again in a moment. Stremio shows the titles from the last refresh, 3 hours ago.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("Not showing in Stremio", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "IMDb could not find this watchlist. Check the link. The list may have been deleted. This problem started 2 days ago.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("2 Lists need attention", { exact: true }),
  ).toBeVisible();

  // The List without a status waits, and the page asks again until it has one.
  await expect(
    screen.getByText("Not refreshed yet", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Updated just now · 10 titles", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    screen.getByText("Not refreshed yet", { exact: true }),
  ).toBeHidden();
  expect(polls.length).toBeGreaterThanOrEqual(2);
});

test("a List added and saved waits for its first refresh, then shows it", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  const saved = "00000000-0000-4000-8000-000000000101";
  await routeSyncStatus(browser, () => ({
    syncStatus: {
      ...configuration.syncStatus,
      [saved]: syncedStatus("imdb:top-rated-movies", 250, ago(0)),
    },
    connections: [],
  }));
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();

  await expect(
    screen.getByText("Not saved yet", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await expect(
    screen.getByText("Updated just now · 250 titles", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText("Not saved yet", { exact: true })).toBeHidden();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].lists).toMatchObject([
    { id: row.id, sourceRef: row.sourceRef },
    { sourceRef: "imdb:top-rated-movies" },
  ]);
});

test("a manual refresh shows the new status of each List", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  let refreshes = 0;
  await browser.route(`${backend}/${accountId}/refresh`, async (route) => {
    refreshes++;
    await route.fulfill({
      json: toJson({
        ok: true,
        refreshed: 0,
        failed: 1,
        total: 1,
        lists: configuration.lists,
        syncStatus: {
          [row.id]: {
            ...syncedStatus(row.sourceRef, 12, ago(10 * MINUTE)),
            lastAttemptAt: ago(0),
            problem: "private",
            failingSince: ago(0),
          },
        },
        connections: [],
        lastFetchedAt: configuration.lastFetchedAt,
        cooldownSeconds: 60,
      }),
    });
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText(/^Updated .+ · 12 titles$/)).toBeVisible();

  await screen.getByRole("button", "Refresh now").tap();

  await expect(
    screen.getByText(
      "Refreshed 0 of 1 lists. The others failed to update: each List shows why.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "This IMDb watchlist is private. Make your watchlist public in your IMDb account settings. Stremio shows the titles from the last refresh, 10 minutes ago.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("Refresh failed · titles from 10 minutes ago", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    screen.getByText("1 List needs attention", { exact: true }),
  ).toBeVisible();
  expect(refreshes).toBe(1);
});

test(
  "a refused Connection asks to renew it, from its List and from the Providers panel",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    await captureConfig(browser, {
      ...configuration,
      lists: [row, traktWatchlist],
      syncStatus: {
        ...configuration.syncStatus,
        [ids.trakt]: {
          sourceRef: "me/watchlist",
          lastAttemptAt: ago(MINUTE),
          lastSuccessAt: ago(60 * MINUTE),
          titleCount: 30,
          problem: "needs_connection",
          failingSince: ago(MINUTE),
        },
      },
      connections: [{ ...traktConnection, needsRenewalSince: ago(MINUTE) }],
    } as AccountConfigResponse);
    const starts = await routeConnectStart(browser);
    await routeTraktSources(browser);
    await app.open(`/configure?account=${accountId}`);

    await expect(
      screen.getByText("Needs renewal", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("Connection needs to be renewed", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(
        "Trakt refused the Stremlist Connection, so this List does not show in Stremio. Connect Trakt again to renew it.",
        { exact: true },
      ),
    ).toBeVisible();
    // One in the Providers panel, one in the List's notice.
    await expect(
      screen.getByRole("button", "Connect again", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Connect again for Trakt Watchlist", {
        exact: true,
      }),
    ).toBeVisible();
    expect(starts).toHaveLength(0);

    await agent.act(
      "Renew the Trakt connection from the Trakt Watchlist list.",
      { maxModelCalls: 4 },
    );

    await browser.waitForURL(`${backend}/authorize-fixture`);
    expect(starts).toEqual(["POST"]);
  },
);

test("a List whose Provider is not connected offers to connect it", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, {
    ...configuration,
    lists: [row, traktWatchlist],
  });
  const starts = await routeConnectStart(browser);
  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByText("Not connected", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Trakt is not connected, so this List does not show in Stremio.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("1 List needs attention", { exact: true }),
  ).toBeVisible();

  await screen
    .getByRole("button", "Connect again for Trakt Watchlist", { exact: true })
    .tap();

  await browser.waitForURL(`${backend}/authorize-fixture`);
  expect(starts).toEqual(["POST"]);
});

test("a Connection that works again clears the renewal state after a poll", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    await route.fulfill({
      json: toJson({
        ...configuration,
        lists: [row, traktWatchlist],
        // The read after the new authorization has not ended yet.
        syncStatus: {
          ...configuration.syncStatus,
          [ids.trakt]: {
            sourceRef: "me/watchlist",
            lastAttemptAt: ago(2 * MINUTE),
            lastSuccessAt: null,
            titleCount: null,
            problem: "needs_connection",
            failingSince: ago(2 * MINUTE),
          },
        },
        connections: [traktConnection],
      }),
    });
  });
  await routeSyncStatus(browser, () => ({
    syncStatus: {
      ...configuration.syncStatus,
      [ids.trakt]: syncedStatus("me/watchlist", 30, ago(0)),
    },
    connections: [traktConnection],
  }));
  await routeTraktSources(browser);
  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByText("Checking the new Connection", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Updated just now · 30 titles", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText(/Lists? needs? attention/)).toBeHidden();
});

test("a refused Connection noticed elsewhere does not claim its cached List is gone", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, {
    ...configuration,
    lists: [row, traktWatchlist],
    syncStatus: {
      ...configuration.syncStatus,
      // The last read of the List worked; an Action then found the token refused.
      [ids.trakt]: syncedStatus("me/watchlist", 30, ago(10 * MINUTE)),
    },
    connections: [{ ...traktConnection, needsRenewalSince: ago(MINUTE) }],
  });
  await routeTraktSources(browser);
  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByText(
      "Trakt refused the Stremlist Connection. Stremio still shows this List from its last refresh, but not after the next one. Connect Trakt again to renew it.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("Connection needs to be renewed", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("1 List needs attention", { exact: true }),
  ).toBeVisible();
});
