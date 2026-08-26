import { expect, test } from "@playwright/test";
import { addonManifestUrl, FRONTEND_URL } from "../env.js";
import { bootstrapUser } from "../helpers/api.js";
import { resetDb } from "../helpers/db.js";
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
    await bootstrapUser(PUBLIC_USER);
    const manifestUrl = addonManifestUrl(PUBLIC_USER);

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
    await bootstrapUser(PUBLIC_USER);
    await page.goto(`${FRONTEND_URL}/configure?userId=${PUBLIC_USER}`);

    const popupPromise = context.waitForEvent("page");
    await page.getByRole("link", { name: "Open in Stremio Web" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(
      `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonManifestUrl(PUBLIC_USER))}`,
    );
    await dismissDesktopAppPrompt(popup);
    await expect(
      popup.getByText("Install", { exact: true }).last(),
    ).toBeVisible();
  },
);
