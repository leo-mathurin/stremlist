import { expect } from "../integration-expect.js";
import { test } from "../integration-browser.js";
import type { Page } from "../integration-browser.js";
import type { ConfigListInput } from "@stremlist/shared/stremio.types";
import { BACKEND_URL, addonManifestUrl } from "../env.js";
import {
  getCatalog,
  getConfig,
  getManifest,
  getMeta,
  isCatalog,
  listInput,
  postConfig,
} from "../helpers/api.js";
import { CATALOG_TITLES, seedCatalog } from "../helpers/catalog.fixture.js";
import { resetDb } from "../helpers/db.js";
import { parsed } from "../helpers/json.js";
import {
  discoverUrl,
  installAddon,
  uninstallAddon,
} from "../helpers/stremio.js";
import { CATALOG_FIXTURE_USER } from "../helpers/test-data.js";
import {
  configureUrl,
  saveConfigure,
  SAVED_REINSTALL,
} from "../helpers/configure.js";

const MATCHES = ["QA Été & café + cinéma", "QA Autumn Drama"];
const FILTERS = {
  genres: ["Drama"],
  decade: 1990,
  maxRuntime: 90,
  minRating: 7,
};
const FILTER_OPTIONS = [
  ["Decade", "1990s"],
  ["Maximum runtime", "90 min or less"],
  ["Minimum IMDb rating", "7 and above"],
] as const;
const ALL_DRAMAS = [...MATCHES, "QA Long Drama", "QA Low Rated Drama"].sort();
const CARDS = 'a[href^="#/detail/"][data-index][title]';

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function chooseGenre(page: Page, label: string, genre: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: genre, exact: true })
    .click();
  await page.keyboard.press("Escape");
}

async function openFilters(page: Page, accountId: string) {
  await page.goto(configureUrl(accountId));
  await page.getByRole("button", { name: "Settings for Release QA" }).click();
  await page.getByRole("button", { name: /Filters & extra catalogs/ }).click();
}

function byCodeUnits(a: string | null, b: string | null) {
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

function cardTitles(page: Page) {
  return page
    .locator(CARDS)
    .evaluateAll((elements) => elements.map((el) => el.getAttribute("title")));
}

async function expectTitles(page: Page, expected: string[]) {
  await expect(page.locator(CARDS)).toHaveCount(expected.length);
  await expect.poll(() => cardTitles(page)).toEqual(expected);
}

async function saveList(accountId: string, list: Partial<ConfigListInput>) {
  const lists = [listInput("imdb", CATALOG_FIXTURE_USER, list)];
  expect((await postConfig(accountId, lists)).status).toBe(200);
}

test.beforeEach(resetDb);

test(
  "combined filters persist through reload and clear without disabling presets",
  { tags: ["local"] },
  async ({ page }) => {
    const { accountId, catalogId } = await seedCatalog();
    await openFilters(page, accountId);
    await chooseGenre(page, "Show genres", "Drama");
    for (const [label, option] of FILTER_OPTIONS) {
      await choose(page, label, option);
    }
    await page
      .getByRole("checkbox", { name: "Top rated", exact: true })
      .check();
    await saveConfigure(page);
    expect((await getConfig(accountId)).body.lists[0].catalogSettings).toEqual({
      ...FILTERS,
      presets: ["rated"],
    });
    expect(
      (await getCatalog(accountId, "movie", catalogId)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(MATCHES);

    await openFilters(page, accountId);
    await expect(
      page.getByRole("button", { name: "Show genres", exact: true }),
    ).toHaveText("Drama");
    for (const [name, option] of FILTER_OPTIONS) {
      await expect(
        page.getByRole("combobox", { name, exact: true }),
      ).toHaveText(option);
    }
    await expect(
      page.getByRole("checkbox", { name: "Top rated", exact: true }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await saveConfigure(page);
    expect((await getConfig(accountId)).body.lists[0].catalogSettings).toEqual({
      presets: ["rated"],
    });
    expect(
      (await getCatalog(accountId, "movie", catalogId)).metas,
    ).toHaveLength(7);
  },
);

test(
  "search combines saved filters with accents and literal URL characters",
  { tags: ["local"] },
  async ({ request }) => {
    const { accountId, id, catalogId } = await seedCatalog();
    await saveList(accountId, {
      id,
      displayMode: "movie",
      catalogSettings: FILTERS,
    });
    for (const [search, names] of [
      ["qa ete & cafe + cinema", [MATCHES[0]]],
      ["drama", [MATCHES[1]]],
      ["long drama", []],
    ] as const) {
      const response = await request.get(
        `${BACKEND_URL}/${accountId}/catalog/movie/${catalogId}/search=${encodeURIComponent(search)}.json`,
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
  { tags: ["local"] },
  async ({ request }) => {
    const metas = Array.from({ length: 215 }, (_, index) => ({
      ...CATALOG_TITLES[0],
      id: `tt${9901000 + index}`,
      name: `QA Page ${index}`,
      runtime: "80m",
    }));
    const { accountId, catalogId } = await seedCatalog(metas);
    const pages: string[][] = [];
    for (const skip of [0, 100, 200, 300]) {
      const url = `${BACKEND_URL}/${accountId}/catalog/movie/${catalogId}/genre=Shuffle&skip=${skip}.json`;
      const first = await request.get(url);
      const second = await request.get(url);
      expect(first.status()).toBe(200);
      const body: unknown = await first.json();
      expect(await second.json()).toEqual(body);
      pages.push(
        parsed(body, isCatalog, "catalog page").metas.map((meta) => meta.id),
      );
    }
    expect(pages.map((page) => page.length)).toEqual([100, 100, 15, 0]);
    expect(new Set(pages.flat()).size).toBe(215);
    expect(pages.flat().sort()).toEqual(metas.map((meta) => meta.id).sort());
  },
);

test(
  "series catalogs remain available while episode metadata is delegated",
  { tags: ["local"] },
  async () => {
    const { accountId, id } = await seedCatalog();
    await saveList(accountId, { id, displayMode: "split" });
    const manifest = await getManifest(accountId);
    expect(manifest.resources).toEqual(
      expect.arrayContaining([
        {
          name: "meta",
          types: ["movie"],
          idPrefixes: ["tt"],
        },
      ]),
    );
    expect(
      (await getCatalog(accountId, "series", `wl-${id}-series`)).metas.map(
        (meta) => meta.name,
      ),
    ).toEqual(["QA Series"]);
    expect(await getMeta(accountId, "series", "tt0903747")).toEqual({
      status: 200,
      meta: null,
    });
  },
);

test(
  "saved filters and the new runtime/date dropdown sorts render in Stremio",
  { tags: ["live-regression"] },
  async ({ page }) => {
    const { accountId, id, catalogId } = await seedCatalog();
    await saveList(accountId, {
      id,
      catalogTitle: "Release QA",
      displayMode: "movie",
      catalogSettings: FILTERS,
    });
    const manifestUrl = addonManifestUrl(accountId);
    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));
    await expectTitles(page, MATCHES);
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
    expect((await getConfig(accountId)).body.lists[0].sortOption).toBe(
      "added_at-asc",
    );
  },
);

test(
  "all three preset catalogs appear after reinstall and serve their expected titles",
  { tags: ["live-regression"] },
  async ({ page }) => {
    const { accountId, catalogId } = await seedCatalog();
    const presets = ["90 min or less", "Top rated", "Shuffle"];
    const manifestUrl = addonManifestUrl(accountId);
    await installAddon(page, manifestUrl);
    await openFilters(page, accountId);
    for (const [label, option] of FILTER_OPTIONS.slice(0, 2)) {
      await choose(page, label, option);
    }
    for (const name of presets) {
      await page.getByRole("checkbox", { name, exact: true }).check();
    }
    await saveConfigure(page, { message: SAVED_REINSTALL });
    await expect(
      page.getByRole("heading", {
        name: "Reinstall in Stremio to see your changes",
      }),
    ).toBeVisible();
    await uninstallAddon(page, manifestUrl);
    await installAddon(page, manifestUrl);
    await page.goto("https://web.stremio.com/#/");
    for (const label of presets) {
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
    await expect
      .poll(async () => (await cardTitles(page)).sort(byCodeUnits))
      .toEqual(ALL_DRAMAS);
    const shuffled = await cardTitles(page);
    expect([...shuffled].sort(byCodeUnits)).toEqual(ALL_DRAMAS);
    await page.reload();
    await expectTitles(page, shuffled.map(String));
  },
);

test(
  "Stremio search sends accented-title queries and respects saved filters",
  { tags: ["live-regression"] },
  async ({ page }) => {
    const { accountId, id, catalogId } = await seedCatalog();
    await saveList(accountId, {
      id,
      catalogTitle: "Release QA",
      displayMode: "movie",
      catalogSettings: FILTERS,
    });
    await installAddon(page, addonManifestUrl(accountId));
    for (const [query, names] of [
      ["qa ete & cafe + cinema", [MATCHES[0]]],
      ["long drama", []],
    ] as const) {
      await page.goto("https://web.stremio.com/#/search");
      const search = page.getByPlaceholder("Search or paste link");
      await expect(search).toHaveValue("");
      const response = page.waitForResponse(
        (res) =>
          res
            .url()
            .startsWith(
              `${BACKEND_URL}/${accountId}/catalog/movie/${catalogId}/`,
            ) && res.url().includes(`search=${encodeURIComponent(query)}.json`),
      );
      await search.fill(query);
      await search.press("Enter");
      await expect(page).toHaveURL(
        (url) =>
          new URLSearchParams(url.hash.split("?")[1]).get("search") === query,
      );
      await Promise.race([
        response,
        page
          .getByText("Stremlist Release QA - Movie", { exact: true })
          .scrollIntoViewIfNeeded({ timeout: 20_000 }),
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
