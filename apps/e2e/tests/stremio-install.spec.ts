import { expect, test } from "@playwright/test";
import { addonManifestUrl, FRONTEND_URL } from "../env.js";
import { bootstrapLegacy } from "../helpers/api.js";
import { resetDb, seedImdbAccount } from "../helpers/db.js";
import {
  addonsDeepLink,
  dismissDesktopAppPrompt,
  installAddon,
} from "../helpers/stremio.js";
import { PUBLIC_USER } from "../helpers/test-data.js";

// Install lifecycle inside the real Stremio Web app (anonymous profile —
// a fresh browser context has its own local addon collection).

test.beforeEach(async () => {
  await resetDb();
});

test(
  "installs and uninstalls the addon through Stremio Web",
  { tag: "@live-smoke" },
  async ({ page }) => {
    const manifestUrl = addonManifestUrl((await seedImdbAccount()).accountId);

    await installAddon(page, manifestUrl);

    // Re-opening the deep link on an installed addon offers Uninstall.
    await page.goto(addonsDeepLink(manifestUrl));
    await page.reload();
    await dismissDesktopAppPrompt(page);
    const uninstall = page.getByText("Uninstall", { exact: true }).last();
    await expect(uninstall).toBeVisible();
    await uninstall.click();

    // And once uninstalled, the same deep link offers Install again.
    await page.goto(addonsDeepLink(manifestUrl));
    await page.reload();
    await dismissDesktopAppPrompt(page);
    await expect(
      page.getByText("Install", { exact: true }).last(),
    ).toBeVisible();
  },
);

test(
  "configure page links straight into Stremio Web's install dialog",
  { tag: "@live-regression" },
  async ({ page, context }) => {
    const { accountId } = await seedImdbAccount();
    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);

    const popupPromise = context.waitForEvent("page");
    await page.getByRole("link", { name: "Open Stremio Web" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(
      `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonManifestUrl(accountId))}`,
    );
    await dismissDesktopAppPrompt(popup);
    await expect(
      popup.getByText("Install", { exact: true }).last(),
    ).toBeVisible();
  },
);

test(
  "a Legacy alias Addon URL still installs in Stremio Web",
  { tag: "@live-regression" },
  async ({ page }) => {
    await bootstrapLegacy(PUBLIC_USER);
    const manifestUrl = addonManifestUrl(PUBLIC_USER);
    await installAddon(page, manifestUrl);
    await page.goto(addonsDeepLink(manifestUrl));
    await page.reload();
    await dismissDesktopAppPrompt(page);
    await expect(
      page.getByText("Uninstall", { exact: true }).last(),
    ).toBeVisible();
  },
);
