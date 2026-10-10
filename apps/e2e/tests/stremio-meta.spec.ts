import { expect, test } from "@playwright/test";
import { addonManifestUrl } from "../env.js";
import { getCatalog } from "../helpers/api.js";
import { resetDb, seedImdbAccount } from "../helpers/db.js";
import { discoverUrl, installAddon } from "../helpers/stremio.js";

// Clicking through from a Stremlist catalog to a detail page in Stremio Web.

test.beforeEach(async () => {
  await resetDb();
});

test(
  "catalog items open their detail page",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { accountId, listId } = await seedImdbAccount();
    const catalogId = `wl-${listId}-movie`;
    const manifestUrl = addonManifestUrl(accountId);
    const { metas } = await getCatalog(accountId, "movie", catalogId);
    const first = metas[0];

    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));

    const firstItem = page.locator('a[href^="#/detail/"]').first();
    await expect(firstItem).toBeVisible();
    await firstItem.click();

    await expect(page).toHaveURL(new RegExp(`#/detail/movie/${first.id}`));
    // The detail page renders the title as a logo image, not text — assert on
    // imagery for the exact tt id we clicked (logo/background src embed it).
    await expect(page.locator(`img[src*="${first.id}"]`).first()).toBeVisible();
  },
);
