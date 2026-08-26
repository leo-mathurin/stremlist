import { expect, test } from "@playwright/test";
import { addonManifestUrl, FRONTEND_URL } from "../env.js";
import { bootstrapUser } from "../helpers/api.js";
import { resetDb } from "../helpers/db.js";
import {
  PUBLIC_USER,
  PUBLIC_USER_2,
  UNKNOWN_USER,
} from "../helpers/test-data.js";

// First-install flow on the Stremlist home page.

test.beforeEach(async ({ page }) => {
  await resetDb();
  await page.goto(FRONTEND_URL);
});

test(
  "new user gets install actions after live validation",
  { tag: "@live-smoke" },
  async ({ page }) => {
    await page.locator("#imdb-id").fill(PUBLIC_USER_2);

    const webInstall = page.getByRole("link", { name: "Open in Stremio Web" });
    await expect(webInstall).toBeVisible();
    await expect(webInstall).toHaveAttribute(
      "href",
      `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonManifestUrl(PUBLIC_USER_2))}`,
    );
    await expect(
      page.getByRole("link", { name: "Open in Stremio Desktop" }),
    ).toHaveAttribute(
      "href",
      `stremio://127.0.0.1:7301/${PUBLIC_USER_2}/manifest.json`,
    );
  },
);

test(
  "returning user is welcomed back",
  { tag: "@live-regression" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    await page.locator("#imdb-id").fill(PUBLIC_USER);
    await expect(page.getByText(`Welcome back, ${PUBLIC_USER}!`)).toBeVisible();
  },
);

test(
  "unknown IMDb id shows the not-found error",
  { tag: "@live-regression" },
  async ({ page }) => {
    await page.locator("#imdb-id").fill(UNKNOWN_USER);
    await expect(
      page.getByText(
        "This IMDb ID does not exist. Please check and try again.",
      ),
    ).toBeVisible();
  },
);

test(
  "garbage input shows the format error",
  { tag: "@local" },
  async ({ page }) => {
    await page.locator("#imdb-id").fill("banana");
    await expect(
      page.getByText("Could not find a valid IMDb ID", { exact: false }),
    ).toBeVisible();
  },
);
