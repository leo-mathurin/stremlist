import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { addonManifestUrl, FRONTEND_URL } from "../env.js";
import { bootstrapLegacy, getConfig } from "../helpers/api.js";
import { resetDb } from "../helpers/db.js";
import {
  PUBLIC_USER,
  PUBLIC_USER_2,
  UNKNOWN_USER,
} from "../helpers/test-data.js";
import { saveButton, SAVE_NEW } from "../helpers/configure.js";

// First-install flow: a link pasted on Home becomes the first List on the
// configure page, and the first save creates the Account.

test.beforeEach(async ({ page }) => {
  await resetDb();
  await page.goto(FRONTEND_URL);
});

async function pasteOnHome(page: Page, link: string) {
  await page.getByLabel("Paste a link to a watchlist or list").fill(link);
  await page.getByRole("button", { name: "Add this list" }).click();
  await expect(page).toHaveURL(`${FRONTEND_URL}/configure`);
}

test(
  "new user gets install actions after live validation",
  { tag: "@live-smoke" },
  async ({ page }) => {
    await pasteOnHome(
      page,
      `https://www.imdb.com/user/${PUBLIC_USER_2}/watchlist`,
    );
    await expect(
      page.getByText(`IMDb · Watchlist · ${PUBLIC_USER_2}`),
    ).toBeVisible();

    const created = page.waitForResponse((res) =>
      res.url().endsWith("/accounts"),
    );
    await saveButton(page, SAVE_NEW).click();
    const { accountId } = (await (await created).json()) as {
      accountId: string;
    };
    expect(accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
    await expect(page).toHaveURL(
      `${FRONTEND_URL}/configure?account=${accountId}`,
    );
    await expect(
      page.getByRole("heading", { name: "Your Stremlist is ready" }),
    ).toBeVisible();
    await expect(page.getByText("Keep this Addon URL secret.")).toBeVisible();

    const webInstall = page.getByRole("link", { name: "Open Stremio Web" });
    await expect(webInstall).toHaveAttribute(
      "href",
      `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonManifestUrl(accountId))}`,
    );
    // Stremio opens `stremio://` links over HTTPS without a port, so the
    // local http://127.0.0.1:7301 Addon URL has no app install link.
    await expect(
      page.getByRole("link", { name: "Install in Stremio" }),
    ).toHaveCount(0);
    expect((await getConfig(accountId)).body.lists).toMatchObject([
      { provider: "imdb", sourceRef: PUBLIC_USER_2 },
    ]);
  },
);

test(
  "returning Legacy alias users land on their configuration",
  { tag: "@local" },
  async ({ page }) => {
    await bootstrapLegacy(PUBLIC_USER);
    // Old links sent returning users to /?userId=ur…
    await page.goto(`${FRONTEND_URL}/?userId=${PUBLIC_USER}`);
    await expect(page).toHaveURL(
      `${FRONTEND_URL}/configure?account=${PUBLIC_USER}`,
    );
    await expect(page.getByText(`IMDb install ${PUBLIC_USER}`)).toBeVisible();
    await expect(
      page.getByText(`IMDb · Watchlist · ${PUBLIC_USER}`),
    ).toBeVisible();
  },
);

test(
  "unknown IMDb id shows the not-found error",
  { tag: "@live-regression" },
  async ({ page }) => {
    await pasteOnHome(page, UNKNOWN_USER);
    await expect(
      page.getByText(
        "IMDb could not find this watchlist. Check the link. The list may have been deleted.",
      ),
    ).toBeVisible();
    await expect(page.getByText("No Lists yet")).toBeVisible();
    await expect(saveButton(page, SAVE_NEW)).toBeDisabled();
  },
);

test(
  "garbage input shows the format error",
  { tag: "@local" },
  async ({ page }) => {
    let resolves = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/links/resolve")) resolves++;
    });
    const field = page.getByLabel("Paste a link to a watchlist or list");
    await field.fill("banana");
    await expect(
      page.getByText("No supported site recognized yet."),
    ).toBeVisible();
    await field.fill("");
    await expect(
      page.getByRole("button", { name: "Build my Stremlist" }),
    ).toBeVisible();
    await pasteOnHome(page, "banana");
    await expect(
      page.getByText("We do not recognize this link.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("No Lists yet")).toBeVisible();
    expect(resolves).toBe(0);
  },
);

test(
  "unknown routes offer a way back home",
  { tag: "@local" },
  async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/this-route-does-not-exist`);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Return to home" }).click();
    await expect(page).toHaveURL(`${FRONTEND_URL}/`);
    await expect(
      page.getByRole("heading", { name: "Your lists, all in Stremio." }),
    ).toBeVisible();
  },
);
