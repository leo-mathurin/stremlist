import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  AccountConfigInput,
  AccountConfigResponse,
} from "@stremlist/shared/stremio.types";
import {
  SAVED,
  SAVED_REINSTALL,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  imdbUser,
  legacyConfiguration,
  parseBody,
  row,
  savedLists,
  toJson,
} from "./config-fixture";

// The "New titles" catalog setting (ADR 0007). Detection itself runs in the
// backend; tests/new-titles.spec.ts covers it against real storage.

const TOGGLE = "Show newly detected titles";
const MOVED_HINT =
  "This install has a private URL now. Make changes from the configure page of your new install.";

function withNewTitles(
  newTitles: AccountConfigResponse["newTitles"],
  base: AccountConfigResponse = configuration,
): AccountConfigResponse {
  return { ...base, newTitles };
}

test(
  "turning on the New titles catalog saves it and asks for a reinstall",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
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
  const submissions = await captureConfig(
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

  await screen.getByRole("checkbox", TOGGLE).tap();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].newTitles).toEqual({ enabled: false });
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

  await screen.getByRole("button", "Save", { exact: true }).tap();
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
  await screen.getByRole("button", "Save and get my Addon URL").tap();

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
