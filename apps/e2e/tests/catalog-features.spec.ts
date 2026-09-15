import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL, addonManifestUrl } from "../env.js";
import {
  getCatalog,
  getConfig,
  getMeta,
  getUserManifest,
  postConfig,
} from "../helpers/api.js";
import { CATALOG_TITLES, seedCatalog } from "../helpers/catalog-fixture.js";
import { resetDb } from "../helpers/db.js";
import {
  discoverUrl,
  installAddon,
  uninstallAddon,
} from "../helpers/stremio.js";

const MATCHES = ["QA Été & café + cinéma", "QA Autumn Drama"];

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function openFilters(page: Page, userId: string) {
  await page.goto(`${FRONTEND_URL}/configure?userId=${userId}`);
  await page.getByRole("button", { name: /Filters & extra catalogs/ }).click();
}

async function save(page: Page) {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();
}

async function expectTitles(page: Page, expected: string[]) {
  const cards = page.locator('a[href^="#/detail/"][data-index][title]');
  await expect(cards).toHaveCount(expected.length);
  await expect
    .poll(() =>
      cards.evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("title")),
      ),
    )
    .toEqual(expected);
}

test.use({ actionTimeout: 20_000 });
test.beforeEach(resetDb);

// These use the real local backend and storage; only the cached IMDb input is seeded.
test(
  "combined filters persist through reload and clear without disabling presets",
  { tag: "@local" },
  async ({ page }) => {
    const { userId, catalogId } = await seedCatalog();
    await openFilters(page, userId);
    await choose(page, "Genre", "Drama");
    await choose(page, "Decade", "1990s");
    await choose(page, "Maximum runtime", "90 min or less");
    await choose(page, "Minimum IMDb rating", "7 and above");
    await page
      .getByRole("checkbox", { name: "Top rated", exact: true })
      .check();
    await save(page);
    expect(
      (await getConfig(userId)).body.watchlists[0].catalogSettings,
    ).toEqual({
      genre: "Drama",
      decade: 1990,
      maxRuntime: 90,
      minRating: 7,
      presets: ["rated"],
    });
    expect(
      (await getCatalog(userId, "movie", catalogId)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(MATCHES);

    await openFilters(page, userId);
    await expect(
      page.getByRole("combobox", { name: "Genre", exact: true }),
    ).toHaveText("Drama");
    await expect(
      page.getByRole("combobox", { name: "Decade", exact: true }),
    ).toHaveText("1990s");
    await expect(
      page.getByRole("combobox", { name: "Maximum runtime", exact: true }),
    ).toHaveText("90 min or less");
    await expect(
      page.getByRole("combobox", { name: "Minimum IMDb rating", exact: true }),
    ).toHaveText("7 and above");
    await expect(
      page.getByRole("checkbox", { name: "Top rated", exact: true }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await save(page);
    expect(
      (await getConfig(userId)).body.watchlists[0].catalogSettings,
    ).toEqual({ presets: ["rated"] });
    expect((await getCatalog(userId, "movie", catalogId)).metas).toHaveLength(
      7,
    );
  },
);

test(
  "search combines saved filters with accents and literal URL characters",
  { tag: "@local" },
  async ({ request }) => {
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
              decade: 1990,
              maxRuntime: 90,
              minRating: 7,
            },
          },
        ])
      ).status,
    ).toBe(200);
    for (const [search, names] of [
      ["qa ete & cafe + cinema", [MATCHES[0]]],
      ["drama", [MATCHES[1]]],
      ["long drama", []],
    ] as const) {
      const response = await request.get(
        `${BACKEND_URL}/${userId}/catalog/movie/${catalogId}/search=${encodeURIComponent(search)}.json`,
      );
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({
        metas: names.map((name) => ({ name })),
      });
    }
  },
);

test(
  "shuffle pagination is stable, complete and contains no duplicate titles",
  { tag: "@local" },
  async ({ request }) => {
    const metas = Array.from({ length: 215 }, (_, index) => ({
      ...CATALOG_TITLES[0],
      id: `tt${9901000 + index}`,
      name: `QA Page ${index}`,
      runtime: "80m",
    }));
    const { userId, catalogId } = await seedCatalog(metas);
    const pages: string[][] = [];
    for (const skip of [0, 100, 200, 300]) {
      const url = `${BACKEND_URL}/${userId}/catalog/movie/${catalogId}/genre=Shuffle&skip=${skip}.json`;
      const first = await request.get(url);
      const second = await request.get(url);
      expect(first.status()).toBe(200);
      const body = await first.json();
      expect(await second.json()).toEqual(body);
      pages.push(body.metas.map((meta: { id: string }) => meta.id));
    }
    expect(pages.map((page) => page.length)).toEqual([100, 100, 15, 0]);
    expect(new Set(pages.flat()).size).toBe(215);
    expect(pages.flat().sort()).toEqual(metas.map((meta) => meta.id).sort());
  },
);

test(
  "series catalogs remain available while episode metadata is delegated",
  { tag: "@local" },
  async () => {
    const { userId, id } = await seedCatalog();
    expect(
      (
        await postConfig(userId, [
          {
            id,
            imdbUserId: userId,
            sortOption: "added_at-asc",
            displayMode: "split",
          },
        ])
      ).status,
    ).toBe(200);
    const manifest = await getUserManifest(userId);
    expect(manifest.resources).toContainEqual({
      name: "meta",
      types: ["movie"],
      idPrefixes: ["tt"],
    });
    expect(
      (await getCatalog(userId, "series", `wl-${id}-series`)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["QA Series"]);
    expect(await getMeta(userId, "series", "tt0903747")).toEqual({
      status: 200,
      meta: null,
    });
  },
);

test(
  "saved filters and the new runtime/date dropdown sorts render in Stremio",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { userId, id, catalogId } = await seedCatalog();
    expect(
      (
        await postConfig(userId, [
          {
            id,
            imdbUserId: userId,
            catalogTitle: "Release QA",
            sortOption: "added_at-asc",
            displayMode: "movie",
            catalogSettings: {
              genre: "Drama",
              decade: 1990,
              maxRuntime: 90,
              minRating: 7,
            },
          },
        ])
      ).status,
    ).toBe(200);
    const manifestUrl = addonManifestUrl(userId);
    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));
    await expectTitles(page, MATCHES);
    // Dropdown interaction is intentional: a deep link alone would not prove
    // that the client exposes and sends the newly advertised options.
    let selectedOption = "Genre";
    for (const [option, expected] of [
      ["Shortest", [...MATCHES].reverse()],
      ["Longest", MATCHES],
      ["Release Date (Oldest)", [...MATCHES].reverse()],
      ["Release Date (Newest)", MATCHES],
    ] as const) {
      await page.getByText(selectedOption, { exact: true }).click();
      await page
        .getByRole("listbox")
        .getByText(option, { exact: true })
        .click();
      selectedOption = option;
      await expectTitles(page, [...expected]);
    }
    expect((await getConfig(userId)).body.watchlists[0].sortOption).toBe(
      "added_at-asc",
    );
  },
);

test(
  "all three preset catalogs appear after reinstall and serve their expected titles",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { userId, catalogId } = await seedCatalog();
    const manifestUrl = addonManifestUrl(userId);
    await installAddon(page, manifestUrl);
    await openFilters(page, userId);
    await choose(page, "Genre", "Drama");
    await choose(page, "Decade", "1990s");
    for (const name of ["90 min or less", "Top rated", "Shuffle"]) {
      await page.getByRole("checkbox", { name, exact: true }).check();
    }
    await save(page);
    await expect(
      page.getByText(
        "Catalog structure changed: reinstall required in Stremio",
      ),
    ).toBeVisible();
    await uninstallAddon(page, manifestUrl);
    await installAddon(page, manifestUrl);
    await page.goto("https://web.stremio.com/#/");
    for (const label of ["90 min or less", "Top rated", "Shuffle"]) {
      await expect(
        page
          .getByText(`Stremlist Release QA · ${label} - Movie`, { exact: true })
          .first(),
      ).toBeVisible();
    }
    await page.goto(discoverUrl(manifestUrl, "movie", `${catalogId}--short`));
    await expectTitles(page, [...MATCHES, "QA Low Rated Drama"]);
    await page.goto(discoverUrl(manifestUrl, "movie", `${catalogId}--rated`));
    await expectTitles(page, [
      "QA Long Drama",
      ...MATCHES,
      "QA Low Rated Drama",
    ]);
    const shuffleResponse = page.waitForResponse((res) =>
      res.url().includes(`/catalog/movie/${catalogId}--shuffle`),
    );
    await page.goto(discoverUrl(manifestUrl, "movie", `${catalogId}--shuffle`));
    expect((await shuffleResponse).status()).toBe(200);
    const cards = page.locator('a[href^="#/detail/"][data-index][title]');
    await expect
      .poll(async () =>
        (
          await cards.evaluateAll((elements) =>
            elements.map((el) => el.getAttribute("title")),
          )
        ).sort(),
      )
      .toEqual([...MATCHES, "QA Long Drama", "QA Low Rated Drama"].sort());
    const shuffled = await cards.evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("title")),
    );
    expect([...shuffled].sort()).toEqual(
      [...MATCHES, "QA Long Drama", "QA Low Rated Drama"].sort(),
    );
    await page.reload();
    await expectTitles(page, shuffled.map(String));
  },
);

test(
  "Stremio search sends accented-title queries and respects saved filters",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { userId, id, catalogId } = await seedCatalog();
    expect(
      (
        await postConfig(userId, [
          {
            id,
            imdbUserId: userId,
            catalogTitle: "Release QA",
            sortOption: "added_at-asc",
            displayMode: "movie",
            catalogSettings: {
              genre: "Drama",
              decade: 1990,
              maxRuntime: 90,
              minRating: 7,
            },
          },
        ])
      ).status,
    ).toBe(200);
    await installAddon(page, addonManifestUrl(userId));
    for (const [query, names] of [
      ["qa ete & cafe + cinema", [MATCHES[0]]],
      ["long drama", []],
    ] as const) {
      // Start each query from a fresh search page so the previous query's row
      // cannot satisfy the lazy-loading scroll before the new results mount.
      await page.goto("https://web.stremio.com/#/search");
      await expect(page.getByPlaceholder("Search or paste link")).toHaveValue(
        "",
      );
      const search = page.getByPlaceholder("Search or paste link");
      const response = page.waitForResponse(
        (res) =>
          res
            .url()
            .startsWith(
              `${BACKEND_URL}/${userId}/catalog/movie/${catalogId}/`,
            ) && res.url().includes(`search=${encodeURIComponent(query)}.json`),
      );
      await search.fill(query);
      await search.press("Enter");
      await expect(page).toHaveURL(
        (url) =>
          new URLSearchParams(url.hash.split("?")[1]).get("search") === query,
      );
      // Rows load on entering the viewport and disappear for empty results.
      // Either receiving the response or revealing the row advances the search.
      await Promise.race([
        response,
        expect(async () => {
          await page
            .getByText("Stremlist Release QA - Movie", { exact: true })
            .scrollIntoViewIfNeeded({ timeout: 1_000 });
        }).toPass({ timeout: 20_000 }),
      ]);
      const result = await response;
      expect(result.status()).toBe(200);
      expect(await result.json()).toMatchObject({
        metas: names.map((name) => ({ name })),
      });
      const match = page.locator('a[title="QA Été & café + cinéma"]');
      if (names.length) await expect(match.first()).toBeVisible();
      else await expect(match).toHaveCount(0);
      await expect(page.locator('a[title="QA Long Drama"]')).toHaveCount(0);
    }
  },
);
