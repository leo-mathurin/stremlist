import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { FRONTEND_URL } from "../env.js";
import {
  getCatalog,
  getConfig,
  getUserManifest,
  postConfig,
} from "../helpers/api.js";
import { CATALOG_TITLES, seedCatalog } from "../helpers/catalog-fixture.js";
import { addWatchlist, resetDb } from "../helpers/db.js";
import { seedCachedCatalog } from "../helpers/r2.js";

const source = 'input[placeholder="ur12345678, p.colneedham, or ls593621567"]';
const title = 'input[placeholder="Tom Hardy\'s Watchlist"]';
async function open(page: Page, userId: string) {
  await page.goto(`${FRONTEND_URL}/configure?userId=${userId}`);
  await expect(page.getByText("Catalog 1", { exact: true })).toBeVisible();
}
async function save(page: Page) {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();
}

test.beforeEach(resetDb);

test(
  "an overlong title is rejected atomically and a corrected title persists",
  { tag: "@local" },
  async ({ page }) => {
    const { userId } = await seedCatalog();
    await open(page, userId);
    await page.locator(title).fill("A".repeat(31));
    const response = page.waitForResponse(
      (res) =>
        res.url().endsWith("/config") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await response).status()).toBe(400);
    await expect(
      page.getByText("Catalog titles must be 30 characters or fewer.", {
        exact: true,
      }),
    ).toBeVisible();
    expect((await getConfig(userId)).body.watchlists[0].catalogTitle).toBe(
      "Release QA",
    );
    await expect(page.locator(title)).toHaveValue("A".repeat(31));
    await page.locator(title).fill("A".repeat(30));
    await save(page);
    expect((await getConfig(userId)).body.watchlists[0].catalogTitle).toBe(
      "A".repeat(30),
    );
    await page.reload();
    await expect(page.locator(title)).toHaveValue("A".repeat(30));
  },
);

test(
  "switching a built-in movie catalog to TV persists its locked content type",
  { tag: "@local" },
  async ({ page }) => {
    const { userId } = await seedCatalog();
    await open(page, userId);
    await page.getByRole("button", { name: "Add Built-in Catalog" }).click();
    await page.getByRole("menuitem", { name: /^Top 250 Movies/ }).click();
    await save(page);
    const before = (await getConfig(userId)).body.watchlists[1];
    await page
      .getByRole("combobox")
      .filter({ hasText: "Top 250 Movies" })
      .click();
    await page
      .getByRole("option", { name: "Top 250 TV Shows", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "View on IMDb" }),
    ).toHaveAttribute("href", "https://www.imdb.com/chart/toptv/");
    await save(page);
    const saved = (await getConfig(userId)).body.watchlists[1];
    expect(saved).toMatchObject({
      id: before.id,
      imdbUserId: "imdb:top-rated-tv",
      displayMode: "series",
    });
    const manifest = await getUserManifest(userId);
    expect(
      manifest.catalogs
        .filter((catalog) => catalog.id.startsWith(`wl-${saved.id}`))
        .map((catalog) => catalog.type),
    ).toEqual(["series"]);
    await page.reload();
    await expect(
      page.getByRole("combobox").filter({ hasText: "Top 250 TV Shows" }),
    ).toBeVisible();
    // Only the regular row exposes a content-type select.
    await expect(
      page
        .getByRole("combobox")
        .filter({ hasText: /Movies only|TV shows only|Movies & TV shows/ }),
    ).toHaveCount(1);
  },
);

test(
  "disabling presets persists, removes manifest rows and retires their old URLs",
  { tag: "@local" },
  async ({ page }) => {
    const { userId, id, catalogId } = await seedCatalog();
    expect(
      (
        await postConfig(userId, [
          {
            id,
            imdbUserId: userId,
            sortOption: "added_at-asc",
            displayMode: "movie",
            catalogSettings: {
              genre: "Drama",
              presets: ["rated", "short", "shuffle"],
            },
          },
        ])
      ).status,
    ).toBe(200);
    expect(
      (await getCatalog(userId, "movie", `${catalogId}--rated`)).metas.length,
    ).toBeGreaterThan(0);
    await open(page, userId);
    await page
      .getByRole("button", { name: /Filters & extra catalogs/ })
      .click();
    for (const name of ["Top rated", "90 min or less", "Shuffle"])
      await page.getByRole("checkbox", { name, exact: true }).uncheck();
    await save(page);
    expect(
      (await getConfig(userId)).body.watchlists[0].catalogSettings,
    ).toEqual({ genre: "Drama", presets: [] });
    expect(
      (await getUserManifest(userId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([catalogId]);
    for (const preset of ["rated", "short", "shuffle"])
      expect(
        (await getCatalog(userId, "movie", `${catalogId}--${preset}`)).metas,
      ).toEqual([]);
    expect(
      (await getCatalog(userId, "movie", catalogId)).metas.map(
        (meta) => meta.name,
      ),
    ).not.toContain("QA Comedy Night");
    await page.reload();
    await page
      .getByRole("button", { name: /Filters & extra catalogs/ })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Genre", exact: true }),
    ).toHaveText("Drama");
    for (const name of ["Top rated", "90 min or less", "Shuffle"])
      await expect(
        page.getByRole("checkbox", { name, exact: true }),
      ).not.toBeChecked();
  },
);

test(
  "saved catalog removal survives reload and its old catalog URL is empty",
  { tag: "@local" },
  async ({ page }) => {
    const { userId, id, catalogId } = await seedCatalog();
    const kept = await addWatchlist(userId, "Keep me", "ls99123456", 1);
    await seedCachedCatalog(kept, [CATALOG_TITLES[5]]);
    expect((await getCatalog(userId, "movie", catalogId)).metas).toHaveLength(
      7,
    );
    await open(page, userId);
    await page.getByRole("button", { name: "Remove catalog" }).first().click();
    await save(page);
    expect(
      (await getConfig(userId)).body.watchlists.map((row) => row.id),
    ).toEqual([kept]);
    expect(
      (await getUserManifest(userId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([`wl-${kept}-movie`]);
    expect((await getCatalog(userId, "movie", `wl-${id}-movie`)).metas).toEqual(
      [],
    );
    expect(
      (await getCatalog(userId, "movie", `wl-${kept}-movie`)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["QA Comedy Night"]);
    await page.reload();
    await expect(page.locator(title)).toHaveValue("Keep me");
    await expect(
      page.getByRole("button", { name: "Remove catalog" }),
    ).toBeDisabled();
  },
);

test(
  "default catalog numbering follows a saved reorder after reload",
  { tag: "@local" },
  async ({ page }) => {
    const { userId, id } = await seedCatalog();
    const second = await addWatchlist(userId, "2", "ls99123456", 1);
    await seedCachedCatalog(second, [CATALOG_TITLES[5]]);
    expect(
      (
        await postConfig(userId, [
          {
            id,
            imdbUserId: userId,
            catalogTitle: "1",
            sortOption: "added_at-asc",
            displayMode: "movie",
          },
          {
            id: second,
            imdbUserId: "ls99123456",
            catalogTitle: "2",
            sortOption: "added_at-asc",
            displayMode: "movie",
          },
        ])
      ).status,
    ).toBe(200);
    await page.setViewportSize({ width: 1280, height: 1800 });
    await open(page, userId);
    const handles = page.getByRole("button", { name: "Drag to reorder" });
    const firstBox = await handles.first().boundingBox();
    const secondBox = await handles.nth(1).boundingBox();
    if (!firstBox || !secondBox)
      throw new Error("Catalog drag handles are not visible");
    await page.mouse.move(
      secondBox.x + secondBox.width / 2,
      secondBox.y + secondBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y - 20, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.locator(source).first()).toHaveValue("ls99123456");
    await expect(page.locator(title).first()).toHaveValue("");
    await save(page);
    expect((await getConfig(userId)).body.watchlists).toMatchObject([
      { id: second, position: 0, catalogTitle: "1" },
      { id, position: 1, catalogTitle: "2" },
    ]);
    await page.reload();
    await expect(page.locator(source).first()).toHaveValue("ls99123456");
    await expect(page.locator(title).first()).toHaveValue("1");
    expect(
      (await getUserManifest(userId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([`wl-${second}-movie`, `wl-${id}-movie`]);
  },
);

test(
  "empty filtered catalog recovers when one restrictive filter is removed",
  { tag: "@local" },
  async ({ page }) => {
    const { userId, catalogId } = await seedCatalog();
    await open(page, userId);
    await page
      .getByRole("button", { name: /Filters & extra catalogs/ })
      .click();
    await page.getByRole("combobox", { name: "Genre", exact: true }).click();
    await page.getByRole("option", { name: "Comedy", exact: true }).click();
    await page.getByRole("combobox", { name: "Decade", exact: true }).click();
    await page.getByRole("option", { name: "2020s", exact: true }).click();
    await save(page);
    expect((await getCatalog(userId, "movie", catalogId)).metas).toEqual([]);
    await page.getByRole("combobox", { name: "Decade", exact: true }).click();
    await page
      .getByRole("option", { name: "All decades", exact: true })
      .click();
    await save(page);
    expect(
      (await getCatalog(userId, "movie", catalogId)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["QA Comedy Night"]);
    await page.reload();
    await page
      .getByRole("button", { name: /Filters & extra catalogs/ })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Genre", exact: true }),
    ).toHaveText("Comedy");
    await expect(
      page.getByRole("combobox", { name: "Decade", exact: true }),
    ).toHaveText("All decades");
  },
);
