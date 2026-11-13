import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { addonManifestUrl, FRONTEND_URL } from "../env.js";
import { hasAccountId, ok } from "../helpers/api.js";
import { configureUrl, saveButton, SAVE_NEW } from "../helpers/configure.js";
import { resetDb } from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { parsed } from "../helpers/json.js";
import { routePageTo } from "../helpers/page-backend.js";
import { addonsDeepLink } from "../helpers/stremio.js";

// The main journey on a phone (390 x 844, touch): Home, add a List, save,
// install, reload. The page talks to a fixture backend that shares the real
// database, so the saved Account is read back. The Trakt link resolves
// through helpers/provider-fixtures.ts, not the real Trakt.

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const TRAKT_LINK = "https://trakt.tv/users/fixture-user/watchlist";

let backend: FixtureBackend;

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider-fixtures.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});
test.beforeEach(resetDb);

/** The page is no wider than the phone: nothing scrolls sideways. */
async function expectNoSidewaysScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

test(
  "on a phone, a link pasted on Home is saved, installs and survives a reload",
  { tag: "@local" },
  async ({ page }) => {
    await routePageTo(page, backend.url);
    await page.goto(FRONTEND_URL);
    const field = page.getByLabel("Paste a link to a watchlist or list");
    await expect(field).toBeVisible();
    await expectNoSidewaysScroll(page);

    await field.fill(TRAKT_LINK);
    await page.getByRole("button", { name: "Add this list" }).tap();
    await expect(page).toHaveURL(`${FRONTEND_URL}/configure`);
    const save = saveButton(page, SAVE_NEW);
    await expect(save).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /^Settings for / }),
    ).toHaveCount(1);
    await expectNoSidewaysScroll(page);

    const created = page.waitForResponse(
      (res) =>
        res.url().endsWith("/accounts") && res.request().method() === "POST",
    );
    await save.tap();
    const response = await created;
    expect(response.status()).toBe(200);
    const { accountId } = parsed(
      await response.json(),
      hasAccountId,
      "the save answer",
    );
    await expect(page).toHaveURL(configureUrl(accountId));

    // Install: the Addon URL and the Stremio Web link fit on the phone.
    const addonUrl = page.getByLabel("Addon URL", { exact: true });
    await expect(addonUrl).toHaveValue(addonManifestUrl(accountId));
    await addonUrl.scrollIntoViewIfNeeded();
    await expect(addonUrl).toBeInViewport();
    const webInstall = page.getByRole("link", { name: "Open Stremio Web" });
    await webInstall.scrollIntoViewIfNeeded();
    await expect(webInstall).toBeInViewport();
    await expect(webInstall).toHaveAttribute(
      "href",
      addonsDeepLink(addonManifestUrl(accountId)),
    );
    await expect(
      page.getByRole("button", { name: "Copy Addon URL" }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);

    const { lists } = ok(await backend.api.getConfig(accountId));
    expect(lists).toMatchObject([
      { provider: "trakt", sourceRef: "users/fixture-user/watchlist" },
    ]);

    await page.reload();
    await expect(page).toHaveURL(configureUrl(accountId));
    await expect(
      page.getByRole("button", { name: /^Settings for / }),
    ).toHaveCount(1);
    await expect(page.getByLabel("Addon URL", { exact: true })).toHaveValue(
      addonManifestUrl(accountId),
    );
    await expectNoSidewaysScroll(page);
  },
);
