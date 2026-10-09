import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  AccountConfigInput,
  AccountConfigResponse,
} from "@stremlist/shared/stremio.types";
import {
  SAVED,
  SAVED_REINSTALL,
  SAVED_WITH_CHANGES,
  SAVE_NEW,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  fitConfigurePage,
  holdToasts,
  imdbUser,
  legacyConfiguration,
  parseBody,
  providerStatus,
  row,
  saveButton,
  savedLists,
  syncedStatus,
  toJson,
} from "./config-fixture";

// The "New titles" catalog setting (ADR 0007). Detection itself runs in the
// backend; tests/new-titles.spec.ts covers it against real storage.

const TOGGLE = "Show newly detected titles";
const NEEDS_REINSTALL = "These changes need a reinstall.";
const MOVED_HINT =
  "This install has a private URL now. Make changes from the configure page of your new install.";

function withNewTitles(
  newTitles: AccountConfigResponse["newTitles"],
): AccountConfigResponse {
  return { ...configuration, newTitles };
}

test(
  "turning on the New titles catalog saves it and asks for a reinstall",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await fitConfigurePage(browser);
    await holdToasts(browser);
    const submissions = await captureConfig(browser);
    await app.open(`/configure?account=${accountId}`);
    await expect(screen.getByRole("checkbox", TOGGLE)).not.toBeChecked();
    await expect(screen.getByText("No new titles detected yet.")).toBeVisible();

    await agent.act(
      "Turn on the catalog of newly detected titles, then save.",
      { maxModelCalls: 5 },
    );

    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    await expect(screen.getByRole("checkbox", TOGGLE)).toBeChecked();
    // The reminder stays until the user says they reinstalled.
    await expect(screen.getByRole("button", "I did it")).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].newTitles).toEqual({ enabled: true });
    expect(submissions[0].lists).toMatchObject([{ id: row.id }]);
  },
);

test("the summary says what was detected and which Lists still wait", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(
    browser,
    withNewTitles({
      enabled: true,
      summary: {
        detected: 3,
        latestDetectedAt: new Date(
          Date.now() - 2 * 24 * 60 * 60_000,
        ).toISOString(),
        waitingLists: 1,
      },
    }),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("checkbox", TOGGLE)).toBeChecked();
  await expect(
    screen.getByText(
      "3 new titles detected, the latest 2 days ago. Stremlist could not read 1 List in full yet, so it cannot compare it.",
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Dates show when Stremlist detected a title, which can be later than when you added it.",
    ),
  ).toBeVisible();
});

test("an unreadable history hides the summary, and an unchanged save needs no reinstall", async ({
  app,
  screen,
  browser,
}) => {
  const submissions = await captureConfig(
    browser,
    withNewTitles({ enabled: true, summary: null }),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("checkbox", TOGGLE)).toBeChecked();
  await expect(screen.getByText(/new titles? detected/)).toHaveCount(0);

  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions[0].newTitles).toEqual({ enabled: true });
});

test("a new setup sends the setting with its first save", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  const created: AccountConfigInput[] = [];
  await browser.route(`${backend}/accounts`, async (route) => {
    const body = parseBody<AccountConfigInput>(route);
    created.push(body);
    await route.fulfill({
      json: toJson({ ok: true, accountId, lists: savedLists(body) }),
    });
  });
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    await route.fulfill({
      json: toJson(
        withNewTitles({
          enabled: true,
          summary: { detected: 0, latestDetectedAt: null, waitingLists: 1 },
        }),
      ),
    });
  });

  await app.open("/configure");
  // A new setup has no history yet, so there is no summary.
  await expect(screen.getByText(/new titles? detected/)).toHaveCount(0);
  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();
  await screen.getByRole("checkbox", TOGGLE).tap();
  await saveButton(screen, SAVE_NEW).tap();

  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  await expect(
    screen.getByText(
      "No new titles detected yet. Stremlist could not read 1 List in full yet, so it cannot compare it.",
    ),
  ).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0].newTitles).toEqual({ enabled: true });
  expect(created[0].lists).toMatchObject([
    { provider: "imdb", sourceRef: "imdb:top-rated-movies" },
  ]);
});

test("a Legacy alias install that moved cannot change the setting", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(
    browser,
    { ...legacyConfiguration, movedAt: "2026-10-01T00:00:00.000Z" },
    imdbUser,
  );
  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByRole("checkbox", TOGGLE)).toBeDisabled();
  await expect(screen.getByText(MOVED_HINT).first()).toBeVisible();
});

test("changing the setting while a save runs keeps it as an unsaved change", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  let releaseSave = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({ json: toJson(configuration) });
      return;
    }
    const submitted = parseBody<AccountConfigInput>(route);
    submissions.push(submitted);
    await responseGate;
    await route.fulfill({
      json: toJson({ ok: true, lists: savedLists(submitted) }),
    });
  });

  await app.open(`/configure?account=${accountId}`);
  await saveButton(screen).tap();
  await expect(saveButton(screen, "Saving")).toBeVisible();
  await screen.getByRole("checkbox", TOGGLE).tap();
  await expect(screen.getByRole("checkbox", TOGGLE)).toBeChecked();
  releaseSave();

  await expect(screen.getByText(SAVED_WITH_CHANGES)).toBeVisible();
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions.map((submitted) => submitted.newTitles)).toEqual([
    { enabled: false },
    { enabled: true },
  ]);
});

test("a refresh updates the summary, and a throttled refresh keeps it", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(
    browser,
    withNewTitles({
      enabled: true,
      summary: { detected: 0, latestDetectedAt: null, waitingLists: 1 },
    }),
  );
  let attempts = 0;
  await browser.route(`${backend}/${accountId}/refresh`, async (route) => {
    attempts += 1;
    const now = Date.now();
    await route.fulfill({
      json:
        attempts === 1
          ? {
              ok: true,
              refreshed: 1,
              failed: 0,
              total: 1,
              lists: toJson(configuration.lists),
              lastFetchedAt: new Date(now).toISOString(),
              cooldownSeconds: 2,
              newTitles: {
                detected: 1,
                latestDetectedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
                waitingLists: 0,
              },
            }
          : {
              ok: true,
              throttled: true,
              refreshed: 0,
              failed: 0,
              total: 0,
              lastFetchedAt: new Date(now).toISOString(),
              cooldownSeconds: 2,
            },
    });
  });

  await app.open(`/configure?account=${accountId}`);
  await expect(
    screen.getByText(
      "No new titles detected yet. Stremlist could not read 1 List in full yet, so it cannot compare it.",
    ),
  ).toBeVisible();
  await screen.getByRole("button", "Refresh now").tap();
  const updated = screen.getByText(
    "1 new title detected, the latest 3 hours ago.",
  );
  await expect(updated).toBeVisible();

  // A throttled refresh read nothing, so the summary stays.
  await expect(screen.getByRole("button", "Refresh now")).toBeEnabled();
  await screen.getByRole("button", "Refresh now").tap();
  await expect(screen.getByRole("button", /Refresh in \d+s/)).toBeDisabled();
  expect(attempts).toBe(2);
  await expect(updated).toBeVisible();
});

test("a save and a disconnect show the summary of what is left", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(
    browser,
    providerStatus({
      simkl: { connectable: false },
      mdblist: { connectable: false },
    }),
  );
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const historyList = {
    ...row,
    id: "00000000-0000-4000-8000-000000000004",
    provider: "trakt",
    sourceRef: "me/history",
    catalogTitle: "Trakt history",
    position: 1,
  } as const;
  let current = withNewTitles({
    enabled: true,
    summary: { detected: 2, latestDetectedAt: twoDaysAgo, waitingLists: 0 },
  });
  current = {
    ...current,
    lists: [row, historyList],
    syncStatus: {
      ...configuration.syncStatus,
      [historyList.id]: syncedStatus(historyList.sourceRef),
    },
    connections: [
      {
        provider: "trakt",
        username: "someone",
        connectedAt: "2026-10-01T00:00:00.000Z",
        needsRenewalSince: null,
      },
    ],
  };
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({ json: toJson(current) });
      return;
    }
    const submitted = parseBody<AccountConfigInput>(route);
    submissions.push(submitted);
    const lists = savedLists(submitted);
    current = { ...current, lists };
    await route.fulfill({
      json: toJson({
        ok: true,
        lists,
        newTitles: {
          detected: 1,
          latestDetectedAt: twoDaysAgo,
          waitingLists: 0,
        },
      }),
    });
  });
  await browser.route(
    `${backend}/${accountId}/connections/trakt/sources`,
    async (route) => {
      await route.fulfill({ json: { sources: [] } });
    },
  );
  // The sync status poll after the save answers the current Connections.
  await browser.route(`${backend}/${accountId}/sync-status`, async (route) => {
    await route.fulfill({
      json: toJson({
        syncStatus: current.syncStatus,
        connections: current.connections,
      }),
    });
  });
  const deletes: string[] = [];
  await browser.route(
    `${backend}/${accountId}/connections/trakt`,
    async (route) => {
      deletes.push(route.request.method);
      // The backend forgets the history of the Lists that only the
      // Connection could read, so the history List waits again.
      current = {
        ...current,
        connections: [],
        newTitles: {
          enabled: true,
          summary: { detected: 0, latestDetectedAt: null, waitingLists: 1 },
        },
      };
      await route.fulfill({ json: { ok: true } });
    },
  );

  await app.open(`/configure?account=${accountId}`);
  await expect(
    screen.getByText("2 new titles detected, the latest 2 days ago."),
  ).toBeVisible();

  await screen.getByRole("button", "Remove Test catalog").tap();
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions[0].lists).toMatchObject([{ id: historyList.id }]);
  await expect(
    screen.getByText("1 new title detected, the latest 2 days ago."),
  ).toBeVisible();

  await screen.getByRole("button", "Connected to Trakt. Disconnect").tap();
  await screen
    .getByRole("group", "Disconnect Trakt?")
    .getByRole("button", "Disconnect")
    .tap();
  await expect(
    screen.getByText(
      "No new titles detected yet. Stremlist could not read 1 List in full yet, so it cannot compare it.",
    ),
  ).toBeVisible();
  expect(deletes).toEqual(["DELETE"]);
});

test("the reinstall notice follows the New titles setting before a save", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(browser);
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("checkbox", TOGGLE)).not.toBeChecked();
  await expect(screen.getByText(NEEDS_REINSTALL, { exact: true })).toBeHidden();

  // Two more Catalogs in the manifest, which Stremio reads at install time.
  await screen.getByRole("checkbox", TOGGLE).tap();
  await expect(
    screen.getByText(NEEDS_REINSTALL, { exact: true }),
  ).toBeVisible();

  // Back to what Stremio has: nothing to reinstall.
  await screen.getByRole("checkbox", TOGGLE).tap();
  await expect(screen.getByText(NEEDS_REINSTALL, { exact: true })).toBeHidden();
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  await expect(screen.getByRole("button", "I did it")).toHaveCount(0);
});
