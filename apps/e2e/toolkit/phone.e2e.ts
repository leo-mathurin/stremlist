import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type { AccountConfigInput } from "@stremlist/shared/stremio.types";
import {
  accountId,
  backend,
  baseRoutes,
  configuration,
  resolved,
  routeCreateAccount,
  routeResolve,
  saveButton,
  savedLists,
  SAVE_NEW,
  toJson,
} from "./config-fixture";

// The main journey at phone width (390 x 844): Home, add a List, save,
// install, reload. Every API answer is intercepted; tests/phone-journey.spec.ts
// runs the same journey against the real backend and database.

const LINK = "https://trakt.tv/users/someone/watchlist";
const ADDON_URL = `${backend}/${accountId}/manifest.json`;

/** The page is no wider than the phone: nothing scrolls sideways. */
async function expectNoSidewaysScroll(browser: Browser) {
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/**
 * Serve the configuration of the fixture Account with the Lists of its first
 * save, as the backend does after the save created it.
 */
async function routeSavedConfig(
  browser: Browser,
  created: AccountConfigInput[],
) {
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    await route.fulfill({
      json: toJson({
        ...configuration,
        lists: created[0] ? savedLists(created[0]) : [],
        syncStatus: {},
      }),
    });
  });
}

test("on a phone, Home adds a List that saves, installs and survives a reload", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const inputs = await routeResolve(browser, (input) =>
    input === LINK
      ? resolved("trakt", "users/someone/watchlist", "watchlist", {
          suggestedTitle: "someone's watchlist",
        })
      : { ok: false, reason: "unrecognized" },
  );
  const created = await routeCreateAccount(browser);
  await routeSavedConfig(browser, created);
  await browser.setViewport({ width: 390, height: 844 });

  await app.open("/");
  const field = screen.getByLabel("Paste a link to a watchlist or list");
  await expect(field).toBeVisible();
  await expectNoSidewaysScroll(browser);
  await field.fill(LINK);
  await screen.getByRole("button", "Add this list").tap();
  await expect(browser).toHaveURL("/configure");

  const settings = screen.getByRole("button", /^Settings for /);
  await expect(settings).toHaveCount(1);
  await expectNoSidewaysScroll(browser);
  await saveButton(screen, SAVE_NEW).tap();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  expect(inputs.map((entry) => entry.input)).toEqual([LINK]);
  expect(created).toHaveLength(1);
  expect(created[0].lists).toMatchObject([
    {
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
      catalogTitle: "someone's watchlist",
      position: 0,
    },
  ]);

  await expect(screen.getByLabel("Addon URL", { exact: true })).toHaveValue(
    ADDON_URL,
  );
  await expect(screen.getByRole("link", "Open Stremio Web")).toHaveAttribute(
    "href",
    `https://web.stremio.com/#/addons?addon=${encodeURIComponent(ADDON_URL)}`,
  );
  await expect(screen.getByRole("button", "Copy Addon URL")).toBeVisible();
  await expectNoSidewaysScroll(browser);

  await browser.reload();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  await expect(
    screen.getByRole("button", "Settings for someone's watchlist"),
  ).toBeVisible();
  await expect(screen.getByLabel("Addon URL", { exact: true })).toHaveValue(
    ADDON_URL,
  );
  await expectNoSidewaysScroll(browser);
  expect(created).toHaveLength(1);
});
