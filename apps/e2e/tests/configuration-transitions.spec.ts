import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  getCatalog,
  getConfig,
  getManifest,
  listInput,
  postConfig,
} from "../helpers/api.js";
import { CATALOG_TITLES, seedCatalog } from "../helpers/catalog-fixture.js";
import { resetDb, seedList } from "../helpers/db.js";
import { seedCachedCatalog } from "../helpers/r2.js";
import { CATALOG_FIXTURE_USER } from "../helpers/test-data.js";
import {
  openConfigure,
  saveButton,
  saveConfigure,
} from "../helpers/configure.js";

async function openSettings(page: Page, title: string) {
  await page.getByRole("button", { name: `Settings for ${title}` }).click();
}
/** The "Provider · kind · detail" line of each List row, in order. */
function rowSources(page: Page) {
  return page.getByText(/^IMDb · (Watchlist|List|Chart)/);
}

test.beforeEach(resetDb);

test(
  "an overlong title is rejected atomically and a corrected title persists",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId, id } = await seedCatalog();
    // The API refuses a 61-character title with a readable error and keeps
    // the stored configuration.
    const rejected = await postConfig(accountId, [
      listInput("imdb", CATALOG_FIXTURE_USER, {
        id,
        catalogTitle: "A".repeat(61),
        displayMode: "movie",
      }),
    ]);
    expect(rejected).toEqual({
      status: 400,
      body: { error: "Catalog titles must be 60 characters or fewer." },
    });
    expect((await getConfig(accountId)).body.lists[0].catalogTitle).toBe(
      "Release QA",
    );

    // The field stops at the limit, so the page can only submit a valid title.
    await openConfigure(page, accountId, "Release QA");
    await openSettings(page, "Release QA");
    const title = page.getByLabel("Catalog title", { exact: true });
    // Clear first: Chromium counts a selected value against maxlength.
    await title.fill("");
    await title.fill("A".repeat(61));
    await expect(title).toHaveValue("A".repeat(60));
    await saveConfigure(page);
    expect((await getConfig(accountId)).body.lists[0].catalogTitle).toBe(
      "A".repeat(60),
    );
    await page.reload();
    await openSettings(page, "A".repeat(60));
    await expect(page.getByLabel("Catalog title", { exact: true })).toHaveValue(
      "A".repeat(60),
    );
  },
);

test(
  "switching a built-in movie chart to TV persists its locked content type",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedCatalog();
    await openConfigure(page, accountId, "Release QA");
    await page.getByRole("button", { name: "Add an IMDb chart" }).click();
    await page.getByRole("menuitem", { name: /^Top 250 Movies/ }).click();
    await saveConfigure(page);
    const before = (await getConfig(accountId)).body.lists[1];
    await openSettings(page, "Top 250 Movies");
    await page.getByRole("combobox", { name: "Built-in chart" }).click();
    await page
      .getByRole("option", { name: "Top 250 TV Shows", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Open on IMDb" }).nth(1),
    ).toHaveAttribute("href", "https://www.imdb.com/chart/toptv/");
    await saveConfigure(page);
    const saved = (await getConfig(accountId)).body.lists[1];
    expect(saved).toMatchObject({
      id: before.id,
      sourceRef: "imdb:top-rated-tv",
      displayMode: "series",
    });
    const manifest = await getManifest(accountId);
    expect(
      manifest.catalogs
        .filter((catalog) => catalog.id.startsWith(`wl-${saved.id}`))
        .map((catalog) => catalog.type),
    ).toEqual(["series"]);
    await page.reload();
    await openSettings(page, "Top 250 Movies");
    await expect(
      page.getByRole("combobox", { name: "Built-in chart" }),
    ).toHaveText("Top 250 TV Shows");
    // Only the regular row exposes a content-type select.
    await openSettings(page, "Release QA");
    await expect(
      page.getByRole("combobox", { name: "Show", exact: true }),
    ).toHaveCount(1);
  },
);

test(
  "disabling presets persists, removes manifest rows and retires their old URLs",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId, id, catalogId } = await seedCatalog();
    expect(
      (
        await postConfig(accountId, [
          listInput("imdb", CATALOG_FIXTURE_USER, {
            id,
            catalogTitle: "Release QA",
            displayMode: "movie",
            catalogSettings: {
              genre: "Drama",
              presets: ["rated", "short", "shuffle"],
            },
          }),
        ])
      ).status,
    ).toBe(200);
    expect(
      (await getCatalog(accountId, "movie", `${catalogId}--rated`)).metas
        .length,
    ).toBeGreaterThan(0);
    await openConfigure(page, accountId, "Release QA");
    await openSettings(page, "Release QA");
    await page
      .getByRole("button", { name: /Filters & extra catalogs/ })
      .click();
    for (const name of ["Top rated", "90 min or less", "Shuffle"]) {
      const checkbox = page.getByRole("checkbox", { name, exact: true });
      await expect(checkbox).toBeChecked();
      await checkbox.press("Space");
      await expect(checkbox).not.toBeChecked();
    }
    await saveConfigure(page);
    expect((await getConfig(accountId)).body.lists[0].catalogSettings).toEqual({
      genre: "Drama",
      presets: [],
    });
    expect(
      (await getManifest(accountId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([catalogId]);
    for (const preset of ["rated", "short", "shuffle"])
      expect(
        (await getCatalog(accountId, "movie", `${catalogId}--${preset}`)).metas,
      ).toEqual([]);
    expect(
      (await getCatalog(accountId, "movie", catalogId)).metas.map(
        (meta) => meta.name,
      ),
    ).not.toContain("QA Comedy Night");
    await page.reload();
    await openSettings(page, "Release QA");
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
  "saved List removal survives reload and its old catalog URL is empty",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId, id, catalogId } = await seedCatalog();
    const kept = await seedList(accountId, {
      sourceRef: "ls99123456",
      catalogTitle: "Keep me",
      position: 1,
    });
    await seedCachedCatalog(kept, [CATALOG_TITLES[5]]);
    expect(
      (await getCatalog(accountId, "movie", catalogId)).metas,
    ).toHaveLength(7);
    await openConfigure(page, accountId, "Release QA");
    await page.getByRole("button", { name: "Remove Release QA" }).click();
    await saveConfigure(page);
    expect(
      (await getConfig(accountId)).body.lists.map((row) => row.id),
    ).toEqual([kept]);
    expect(
      (await getManifest(accountId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([`wl-${kept}-movie`]);
    expect(
      (await getCatalog(accountId, "movie", `wl-${id}-movie`)).metas,
    ).toEqual([]);
    expect(
      (await getCatalog(accountId, "movie", `wl-${kept}-movie`)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["QA Comedy Night"]);
    await page.reload();
    await expect(page.getByText("Keep me", { exact: true })).toBeVisible();
    await expect(page.getByText("Release QA", { exact: true })).toHaveCount(0);
    // An Account keeps at least one List: without one, Save is off.
    await page.getByRole("button", { name: "Remove Keep me" }).click();
    await expect(page.getByText("No Lists yet")).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
  },
);

test(
  "default catalog numbering follows a saved reorder after reload",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId, id } = await seedCatalog();
    const second = await seedList(accountId, {
      sourceRef: "ls99123456",
      catalogTitle: "2",
      position: 1,
    });
    await seedCachedCatalog(second, [CATALOG_TITLES[5]]);
    expect(
      (
        await postConfig(accountId, [
          listInput("imdb", CATALOG_FIXTURE_USER, {
            id,
            catalogTitle: "1",
            displayMode: "movie",
          }),
          listInput("imdb", "ls99123456", {
            id: second,
            catalogTitle: "2",
            displayMode: "movie",
          }),
        ])
      ).status,
    ).toBe(200);
    await page.setViewportSize({ width: 1280, height: 1800 });
    await openConfigure(page, accountId, "1");
    const firstBox = await page
      .getByRole("button", { name: "Drag to reorder 1", exact: true })
      .boundingBox();
    const secondBox = await page
      .getByRole("button", { name: "Drag to reorder 2", exact: true })
      .boundingBox();
    if (!firstBox || !secondBox)
      throw new Error("List drag handles are not visible");
    await page.mouse.move(
      secondBox.x + secondBox.width / 2,
      secondBox.y + secondBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y - 20, {
      steps: 12,
    });
    await page.mouse.up();
    // Numbered default titles follow the position, so the page drops them.
    await expect(rowSources(page)).toHaveText([
      "IMDb · List · ls99123456",
      `IMDb · Watchlist · ${CATALOG_FIXTURE_USER}`,
    ]);
    await expect(page.getByText("1", { exact: true })).toHaveCount(0);
    await saveConfigure(page);
    expect((await getConfig(accountId)).body.lists).toMatchObject([
      { id: second, position: 0, catalogTitle: "1" },
      { id, position: 1, catalogTitle: "2" },
    ]);
    await page.reload();
    await expect(rowSources(page)).toHaveText([
      "IMDb · List · ls99123456",
      `IMDb · Watchlist · ${CATALOG_FIXTURE_USER}`,
    ]);
    await expect(
      page.getByRole("button", { name: "Drag to reorder 1", exact: true }),
    ).toBeVisible();
    expect(
      (await getManifest(accountId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([`wl-${second}-movie`, `wl-${id}-movie`]);
  },
);

test(
  "empty filtered catalog recovers when one restrictive filter is removed",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId, catalogId } = await seedCatalog();
    await openConfigure(page, accountId, "Release QA");
    await openSettings(page, "Release QA");
    await page
      .getByRole("button", { name: /Filters & extra catalogs/ })
      .click();
    await page.getByRole("combobox", { name: "Genre", exact: true }).click();
    await page.getByRole("option", { name: "Comedy", exact: true }).click();
    await page.getByRole("combobox", { name: "Decade", exact: true }).click();
    await page.getByRole("option", { name: "2020s", exact: true }).click();
    await saveConfigure(page);
    expect((await getCatalog(accountId, "movie", catalogId)).metas).toEqual([]);
    await page.getByRole("combobox", { name: "Decade", exact: true }).click();
    await page
      .getByRole("option", { name: "All decades", exact: true })
      .click();
    await saveConfigure(page);
    expect(
      (await getCatalog(accountId, "movie", catalogId)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["QA Comedy Night"]);
    await page.reload();
    await openSettings(page, "Release QA");
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
