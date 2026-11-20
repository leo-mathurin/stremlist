import { expect } from "../integration-expect.js";
import { emulatePhone, tapOn, test } from "../integration-browser.js";
import type { Page } from "../integration-browser.js";
import { addonManifestUrl, FRONTEND_URL } from "../env.js";
import { hasAccountId, ok } from "../helpers/api.js";
import { configureUrl, saveButton, SAVE_NEW } from "../helpers/configure.js";
import { resetDb } from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { parsed } from "../helpers/json.js";
import { routePageTo } from "../helpers/page-backend.js";
import { addonsDeepLink } from "../helpers/stremio.js";

test.beforeEach(async ({ page }) => emulatePhone(page, 3));

const TRAKT_LINK = "https://trakt.tv/users/fixture-user/watchlist";

let backend: FixtureBackend;

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider.fixture.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});
test.beforeEach(resetDb);

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
  { tags: ["local"] },
  async ({ page }) => {
    await routePageTo(page, backend.url);
    await page.goto(FRONTEND_URL);
    const field = page.getByLabel("Paste a link to a watchlist or list");
    await expect(field).toBeVisible();
    await expectNoSidewaysScroll(page);

    await field.fill(TRAKT_LINK);
    await tapOn(page, page.getByRole("button", { name: "Add this list" }));
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
    await tapOn(page, save);
    const response = await created;
    expect(response.status()).toBe(200);
    const { accountId } = parsed(
      await response.json(),
      hasAccountId,
      "the save answer",
    );
    await expect(page).toHaveURL(configureUrl(accountId));

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
