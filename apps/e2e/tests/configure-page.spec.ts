import { expect, test } from "@playwright/test";
import { FRONTEND_URL } from "../env.js";
import { bootstrapUser, getConfig } from "../helpers/api.js";
import { resetDb } from "../helpers/db.js";
import {
  PUBLIC_LIST,
  PUBLIC_USER,
  UNKNOWN_USER,
} from "../helpers/test-data.js";

// The /configure page: catalog management, options, refresh, install links.

const configureUrl = (userId: string) =>
  `${FRONTEND_URL}/configure?userId=${userId}`;

test.beforeEach(async () => {
  await resetDb();
});

test(
  "loads the existing configuration",
  { tag: "@local" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    await page.goto(configureUrl(PUBLIC_USER));

    await expect(page.getByText("Catalog 1")).toBeVisible();
    await expect(
      page.locator(`input[value="${PUBLIC_USER}"]`).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open in Stremio Web" }),
    ).toBeVisible();
  },
);

test(
  "adds an ls list catalog and saves",
  { tag: "@local" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    await page.goto(configureUrl(PUBLIC_USER));
    await expect(page.getByText("Catalog 1")).toBeVisible();

    await page.getByRole("button", { name: "Add Catalog" }).click();
    await expect(page.getByText("Catalog 2")).toBeVisible();

    const idInputs = page.locator('input[placeholder*="ur12345678"]');
    await idInputs.last().fill(PUBLIC_LIST);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved!", { exact: false })).toBeVisible();

    const { body } = await getConfig(PUBLIC_USER);
    expect(body.watchlists).toHaveLength(2);
    expect(body.watchlists.map((w) => w.imdbUserId)).toContain(PUBLIC_LIST);
  },
);

test("adds a built-in chart catalog", { tag: "@local" }, async ({ page }) => {
  await bootstrapUser(PUBLIC_USER);
  await page.goto(configureUrl(PUBLIC_USER));
  await expect(page.getByText("Catalog 1")).toBeVisible();

  await page.getByRole("button", { name: "Add Built-in Catalog" }).click();
  await page.getByRole("menuitem", { name: "Top 250 Movies" }).click();
  await expect(page.getByText("Built-in", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();

  const { body } = await getConfig(PUBLIC_USER);
  expect(body.watchlists.map((w) => w.imdbUserId)).toContain(
    "imdb:top-rated-movies",
  );
});

test(
  "changes sort order and content filter",
  { tag: "@local" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    await page.goto(configureUrl(PUBLIC_USER));
    await expect(page.getByText("Catalog 1")).toBeVisible();

    // Radix selects: one combobox for "Sort Order", one for "Show", in DOM order.
    await page.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: "Highest Rated" }).click();
    await page.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Movies only" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved!", { exact: false })).toBeVisible();

    const { body } = await getConfig(PUBLIC_USER);
    expect(body.watchlists[0].sortOption).toBe("rating-desc");
    expect(body.watchlists[0].displayMode).toBe("movie");
  },
);

test("saves and clears the RPDB key", { tag: "@local" }, async ({ page }) => {
  await bootstrapUser(PUBLIC_USER);
  await page.goto(configureUrl(PUBLIC_USER));
  await expect(page.getByText("Catalog 1")).toBeVisible();

  await page.locator("#rpdb-api-key").fill("e2e-rpdb-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();
  expect((await getConfig(PUBLIC_USER)).body.rpdbApiKey).toBe("e2e-rpdb-key");

  await page.locator("#rpdb-api-key").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();
  expect((await getConfig(PUBLIC_USER)).body.rpdbApiKey).toBeNull();
});

test("removes a catalog", { tag: "@local" }, async ({ page }) => {
  await bootstrapUser(PUBLIC_USER);
  await page.goto(configureUrl(PUBLIC_USER));
  await page.getByRole("button", { name: "Add Built-in Catalog" }).click();
  await page.getByRole("menuitem", { name: "Box Office (Weekend)" }).click();
  await expect(page.getByText("Catalog 2")).toBeVisible();

  await page.getByLabel("Remove catalog").last().click();
  await expect(page.getByText("Catalog 2")).not.toBeVisible();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();
  expect((await getConfig(PUBLIC_USER)).body.watchlists).toHaveLength(1);
});

test(
  "manual refresh hits the backend and starts the cooldown",
  { tag: "@live-regression" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    await page.goto(configureUrl(PUBLIC_USER));
    await expect(page.getByText("Catalog 1")).toBeVisible();

    const refreshResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/refresh") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /Refresh now|Refresh in/ }).click();
    expect((await refreshResponse).status()).toBe(200);
  },
);

test(
  "unknown user is told to install first",
  { tag: "@local" },
  async ({ page }) => {
    await page.goto(configureUrl(UNKNOWN_USER));
    await expect(
      page.getByText("User not found.", { exact: false }),
    ).toBeVisible();
  },
);

test(
  "without userId, entering an id loads its configuration",
  { tag: "@local" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    await page.goto(`${FRONTEND_URL}/configure`);
    await page.locator("#imdb-id").fill(PUBLIC_USER);
    await expect(page).toHaveURL(new RegExp(`userId=${PUBLIC_USER}`));
    await expect(page.getByText("Catalog 1")).toBeVisible();
  },
);
