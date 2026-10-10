import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  AccountSyncSnapshot,
  ConfigList,
} from "@stremlist/shared/stremio.types";
import type { ListSyncStatus } from "@stremlist/shared/sync-status";
import {
  SAVED_REINSTALL,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  connected,
  fitConfigurePage,
  imdbUser,
  legacyConfiguration,
  parseBody,
  previewOf,
  row,
  saveButton,
  syncedStatus,
  toJson,
  MINUTE,
  ago,
  routeConnectStart,
  routeConnectionSources,
} from "./config-fixture";
import type { PreviewRequest } from "./config-fixture";

// The sync status of each List (STR-58): what each row says about its last
// refresh, and the Connections that need to be renewed. The API is
// intercepted; the Playwright spec `sync-status.spec.ts` checks the real
// recording.

const ids = {
  synced: row.id,
  older: "00000000-0000-4000-8000-000000000002",
  missing: "00000000-0000-4000-8000-000000000003",
  waiting: "00000000-0000-4000-8000-000000000004",
  trakt: "00000000-0000-4000-8000-000000000005",
  chart: "00000000-0000-4000-8000-000000000006",
  history: "00000000-0000-4000-8000-000000000007",
  justwatch: "00000000-0000-4000-8000-000000000008",
  mdblist: "00000000-0000-4000-8000-000000000009",
  empty: "00000000-0000-4000-8000-00000000000a",
};

/** Wait without a condition: proves that something does not happen. */
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

function list(
  id: string,
  sourceRef: string,
  catalogTitle: string,
  provider: ConfigList["provider"] = "imdb",
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

/**
 * Answer `/sync-status` of `key` with `answer(poll)`; returns how often it
 * was asked.
 */
async function routeSyncStatus(
  browser: Browser,
  answer: (poll: number) => AccountSyncSnapshot,
  key = accountId,
) {
  const polls: string[] = [];
  await browser.route(`${backend}/${key}/sync-status`, async (route) => {
    polls.push(route.request.method);
    await route.fulfill({ json: toJson(answer(polls.length)) });
  });
  return polls;
}

test("each List shows its last refresh or why it failed, and a new List is polled until it refreshes", async ({
  app,
  browser,
  screen,
}) => {
  const synced = syncedStatus(row.sourceRef, 12, ago(5 * MINUTE));
  const older: ListSyncStatus = {
    provider: "imdb",
    sourceRef: "imdb:most-popular-tv",
    lastAttemptAt: ago(5 * MINUTE),
    lastSuccessAt: ago(3 * 60 * MINUTE),
    titleCount: 100,
    problem: "unavailable",
    failingSince: ago(40 * MINUTE),
  };
  const missing: ListSyncStatus = {
    provider: "imdb",
    sourceRef: "ur99000017",
    lastAttemptAt: ago(MINUTE),
    lastSuccessAt: null,
    titleCount: null,
    problem: "not_found",
    failingSince: ago(2 * 24 * 60 * MINUTE),
  };
  const statuses = {
    [ids.synced]: [synced],
    [ids.older]: [older],
    [ids.missing]: [missing],
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
  });
  const polls = await routeSyncStatus(browser, (poll) => ({
    syncStatus:
      poll < 2
        ? statuses
        : {
            ...statuses,
            [ids.waiting]: [syncedStatus("imdb:box-office", 10, ago(0))],
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
  // Nothing waits any more, so the page stops asking (one poll is 4 s).
  const asked = polls.length;
  await pause(5_000);
  expect(polls).toHaveLength(asked);
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
      [saved]: [syncedStatus("imdb:top-rated-movies", 250, ago(0))],
    },
    connections: [],
  }));
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();

  await expect(
    screen.getByText("Not saved yet", { exact: true }),
  ).toBeVisible();
  await saveButton(screen).tap();
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
          [row.id]: [
            {
              ...syncedStatus(row.sourceRef, 12, ago(10 * MINUTE)),
              lastAttemptAt: ago(0),
              problem: "private",
              failingSince: ago(0),
            },
          ],
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
        [ids.trakt]: [
          {
            provider: "trakt",
            sourceRef: "me/watchlist",
            lastAttemptAt: ago(MINUTE),
            lastSuccessAt: ago(60 * MINUTE),
            titleCount: 30,
            problem: "needs_connection",
            failingSince: ago(MINUTE),
          },
        ],
      },
      connections: [{ ...traktConnection, needsRenewalSince: ago(MINUTE) }],
    });
    const starts = await routeConnectStart(browser);
    await routeConnectionSources(browser);
    await fitConfigurePage(browser);
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
          [ids.trakt]: [
            {
              provider: "trakt",
              sourceRef: "me/watchlist",
              lastAttemptAt: ago(2 * MINUTE),
              lastSuccessAt: null,
              titleCount: null,
              problem: "needs_connection",
              failingSince: ago(2 * MINUTE),
            },
          ],
        },
        connections: [traktConnection],
      }),
    });
  });
  await routeSyncStatus(browser, () => ({
    syncStatus: {
      ...configuration.syncStatus,
      [ids.trakt]: [syncedStatus("me/watchlist", 30, ago(0), "trakt")],
    },
    connections: [traktConnection],
  }));
  await routeConnectionSources(browser);
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
      [ids.trakt]: [
        syncedStatus("me/watchlist", 30, ago(10 * MINUTE), "trakt"),
      ],
    },
    connections: [{ ...traktConnection, needsRenewalSince: ago(MINUTE) }],
  });
  await routeConnectionSources(browser);
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

test("each failure reason says what to do, next to Lists that refresh fine", async ({
  app,
  browser,
  screen,
}) => {
  const lists = [
    row,
    list(ids.empty, "imdb:box-office", "Box office"),
    list(ids.history, "users/fixture/lists/horror", "Horror nights", "trakt"),
    list(
      ids.justwatch,
      "tl-us-11111111-2222-4333-8444-555555555555",
      "Weekend picks",
      "justwatch",
    ),
    list(ids.mdblist, "lists/4242", "Top rated", "mdblist"),
  ];
  await captureConfig(browser, {
    ...configuration,
    lists,
    syncStatus: {
      [row.id]: [syncedStatus(row.sourceRef, 1, ago(2 * 60 * MINUTE))],
      [ids.empty]: [syncedStatus("imdb:box-office", 0, ago(30 * MINUTE))],
      // A public Trakt list that Trakt refused without an account.
      [ids.history]: [
        {
          provider: "trakt",
          sourceRef: "users/fixture/lists/horror",
          lastAttemptAt: ago(MINUTE),
          lastSuccessAt: null,
          titleCount: null,
          problem: "needs_connection",
          failingSince: ago(20 * MINUTE),
        },
      ],
      [ids.justwatch]: [
        {
          provider: "justwatch",
          sourceRef: "tl-us-11111111-2222-4333-8444-555555555555",
          lastAttemptAt: ago(MINUTE),
          lastSuccessAt: ago(3 * 24 * 60 * MINUTE),
          titleCount: 8,
          problem: "private",
          failingSince: ago(2 * 24 * 60 * MINUTE),
        },
      ],
      [ids.mdblist]: [
        {
          provider: "mdblist",
          sourceRef: "lists/4242",
          lastAttemptAt: ago(MINUTE),
          lastSuccessAt: null,
          titleCount: null,
          problem: "premium_only",
          failingSince: ago(3 * 60 * MINUTE),
        },
      ],
    },
    connections: [connected("mdblist")],
  });
  await routeConnectionSources(browser, "mdblist");
  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByText("Updated 2 hours ago · 1 title", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Updated 30 minutes ago · no titles", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "This list needs your Trakt account. Connect Trakt in the Providers panel. This problem started 20 minutes ago.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "This JustWatch list is not shared. In JustWatch, open the list and choose Share to get its link. Stremio shows the titles from the last refresh, 3 days ago.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("Refresh failed · titles from 3 days ago", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "This list needs a paid MDBList plan. MDBList only shares it with paid accounts. This problem started 3 hours ago.",
      { exact: true },
    ),
  ).toBeVisible();
  // The Trakt and MDBList Lists show nothing in Stremio; JustWatch shows older titles.
  await expect(
    screen.getByText("Not showing in Stremio", { exact: true }),
  ).toHaveCount(2);
  await expect(
    screen.getByText("3 Lists need attention", { exact: true }),
  ).toBeVisible();
  // A public List does not offer to renew a Connection.
  await expect(screen.getByRole("button", /^Connect again for /)).toHaveCount(
    0,
  );
});

test("each List that needs a Connection names its own Connect again button", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, {
    ...configuration,
    lists: [
      row,
      traktWatchlist,
      list(ids.history, "me/history", "Trakt History", "trakt"),
    ],
  });
  const starts = await routeConnectStart(browser);
  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByRole("button", "Connect again for Trakt Watchlist", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByText("Not connected", { exact: true })).toHaveCount(
    2,
  );
  await expect(
    screen.getByText("2 Lists need attention", { exact: true }),
  ).toBeVisible();

  await screen
    .getByRole("button", "Connect again for Trakt History", { exact: true })
    .tap();

  await browser.waitForURL(`${backend}/authorize-fixture`);
  expect(starts).toEqual(["POST"]);
});

test("a Legacy alias install shows the sync status of its Lists and polls through its alias", async ({
  app,
  browser,
  screen,
}) => {
  const statuses = {
    [row.id]: [syncedStatus(row.sourceRef, 12, ago(5 * MINUTE))],
  };
  await captureConfig(
    browser,
    {
      ...legacyConfiguration,
      lists: [row, list(ids.waiting, "imdb:box-office", "Box office")],
      syncStatus: statuses,
    },
    imdbUser,
  );
  const polls = await routeSyncStatus(
    browser,
    (poll) => ({
      syncStatus:
        poll < 2
          ? statuses
          : {
              ...statuses,
              [ids.waiting]: [syncedStatus("imdb:box-office", 10, ago(0))],
            },
      connections: [],
    }),
    imdbUser,
  );
  await app.open(`/configure?account=${imdbUser}`);

  await expect(
    screen.getByText("Updated 5 minutes ago · 12 titles", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Not refreshed yet", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Updated just now · 10 titles", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  expect(polls.length).toBeGreaterThanOrEqual(2);
});

test("a new setup shows no sync status before its first save", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  await app.open("/configure");
  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();

  await expect(saveButton(screen, "Save and get my Addon URL")).toBeEnabled();
  await expect(screen.getByText("Not saved yet", { exact: true })).toHaveCount(
    0,
  );
  await expect(screen.getByText(/needs? attention/)).toHaveCount(0);
});

test("a saved List whose chart changes is not saved yet, and is polled only after the save", async ({
  app,
  browser,
  screen,
}) => {
  const chart = list(ids.chart, "imdb:top-rated-movies", "Top movies");
  const submissions = await captureConfig(browser, {
    ...configuration,
    lists: [row, chart],
    syncStatus: {
      ...configuration.syncStatus,
      [ids.chart]: [syncedStatus(chart.sourceRef, 250, ago(5 * MINUTE))],
    },
  });
  const polls = await routeSyncStatus(browser, () => ({
    syncStatus: {
      ...configuration.syncStatus,
      [ids.chart]: [syncedStatus("imdb:top-rated-tv", 250, ago(0))],
    },
    connections: [],
  }));
  await app.open(`/configure?account=${accountId}`);
  await expect(
    screen.getByText("Updated 5 minutes ago · 250 titles", { exact: true }),
  ).toBeVisible();

  await screen.getByRole("button", "Settings for Top movies").tap();
  await screen.getByRole("combobox", "Built-in chart").tap();
  await screen.getByRole("option", "Top 250 TV Shows", { exact: true }).tap();

  await expect(
    screen.getByText("Not saved yet", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Not refreshed yet", { exact: true }),
  ).toHaveCount(0);
  // Another chart is another Catalog: Stremio needs a reinstall to show it.
  await expect(
    screen.getByText("These changes need a reinstall.", { exact: true }),
  ).toBeVisible();
  await pause(5_000);
  expect(polls).toHaveLength(0);

  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await expect(
    screen.getByText("Updated just now · 250 titles", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  // The new status does not end the reminder: only the user can.
  await expect(screen.getByRole("button", "I did it")).toBeVisible();
  expect(submissions.at(-1)?.lists[1]).toMatchObject({
    id: ids.chart,
    sourceRef: "imdb:top-rated-tv",
  });
});

test("an open preview is read again when a refresh finds its Connection refused", async ({
  app,
  browser,
  screen,
}) => {
  // The Trakt Watchlist was just saved: the page polls for its first refresh.
  await captureConfig(browser, {
    ...configuration,
    lists: [row, traktWatchlist],
    connections: [traktConnection],
  });
  await routeConnectionSources(browser);
  const previews: PreviewRequest[] = [];
  let refused = false;
  await browser.route(`${backend}/lists/preview`, async (route) => {
    const request = parseBody<PreviewRequest>(route);
    previews.push(request);
    await route.fulfill({
      json: toJson(
        refused
          ? { ok: false, reason: "needs_connection" }
          : previewOf(request),
      ),
    });
  });
  const polls = await routeSyncStatus(browser, () => {
    refused = true;
    return {
      syncStatus: {
        ...configuration.syncStatus,
        [ids.trakt]: [
          {
            provider: "trakt",
            sourceRef: "me/watchlist",
            lastAttemptAt: ago(0),
            lastSuccessAt: null,
            titleCount: null,
            problem: "needs_connection",
            failingSince: ago(0),
          },
        ],
      },
      connections: [{ ...traktConnection, needsRenewalSince: ago(0) }],
    };
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(
    screen.getByText("Not refreshed yet", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Preview Trakt Watchlist").tap();
  await expect(screen.getByText("The Godfather")).toBeVisible();

  await expect(
    screen.getByText("Connection needs to be renewed", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  // The preview does not keep Titles that the refused Connection cannot read.
  await expect(
    screen.getByText(
      "This watchlist needs your Trakt account. Connect Trakt on the Stremlist configure page.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(screen.getByText("The Godfather")).toBeHidden();
  expect(previews).toHaveLength(2);
  expect(previews[1]).toMatchObject({
    accountKey: accountId,
    provider: "trakt",
    sourceRef: "me/watchlist",
  });
  expect(polls.length).toBeGreaterThan(0);
});
