import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  CatalogPreview,
  CatalogPreviewResponse,
  CatalogTitlesPage,
  PreviewTitle,
} from "@stremlist/shared/catalog-preview";
import { BACKEND_URL } from "../env.js";
import type { Api, PreviewInput } from "../helpers/api.js";
import { api } from "../helpers/api.js";
import { configureUrl } from "../helpers/configure.js";
import {
  clearResolverCache,
  getListRows,
  getResolverRows,
  getSyncStatusRows,
  resetDb,
  seedAccount,
  seedAccountWithLists,
  seedConnection,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import {
  PREVIEW_PRIVATE_LIST,
  PREVIEW_PRODUCT_IDS,
  PREVIEW_PUBLIC_LIST,
} from "../helpers/preview-fixture.js";
import { isRecord, present } from "../helpers/json.js";
import { countCacheObjects } from "../helpers/r2.js";
import { CATALOG_FIXTURE_USER, PUBLIC_LIST } from "../helpers/test-data.js";

// The Catalog preview (POST /lists/preview, STR-57) against real handlers.
// A second backend reads a synthetic SensCritique list through the real
// adapter, ID resolver (with its Supabase cache) and IMDb enrichment, with
// only the outbound Provider transport replaced (helpers/provider-fixtures.ts).
// The standard backend covers the access rules and a live IMDb list.

const PUBLIC_REF = `lists/${PREVIEW_PUBLIC_LIST}`;
const PRIVATE_REF = `lists/${PREVIEW_PRIVATE_LIST}`;
const ANIMATION_LIST = {
  provider: "senscritique",
  sourceRef: PUBLIC_REF,
  catalogTitle: "Animation fixture",
} as const;

let backend: FixtureBackend;

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider-fixtures.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  // Forget what earlier runs resolved for the synthetic products.
  await clearResolverCache("senscritique", PREVIEW_PRODUCT_IDS);
});

/** A preview through `through`, sorted by date added and split by default. */
async function preview(
  through: Api,
  input: Omit<PreviewInput, "sortOption"> & { sortOption?: string },
): Promise<CatalogPreviewResponse> {
  const { status, body } = await through.previewList({
    sortOption: "added_at-asc",
    displayMode: "split",
    ...input,
  });
  expect(status).toBe(200);
  return body;
}

function previewOk(result: CatalogPreviewResponse) {
  if (!result.ok) throw new Error(`Preview refused: ${result.reason}`);
  return result;
}

test(
  "a preview resolves the Source list and lists its Unresolved entries",
  { tag: "@local" },
  async () => {
    // The backend keeps a read for minutes: a retry asks for a list that it
    // did not read yet, so the resolver runs (and writes its cache) again.
    const result = previewOk(
      await preview(backend.api, {
        provider: "senscritique",
        sourceRef: `lists/${PREVIEW_PUBLIC_LIST + 100 + test.info().retry}`,
      }),
    );

    expect(result.titleCount).toBe(2);
    expect(result.typeCounts).toEqual({ movie: 2, series: 0 });
    expect(
      result.catalogs.map(({ type, preset, total, titles }) => ({
        type,
        preset,
        total,
        titles: titles.map(({ id, name, releaseInfo }) => ({
          id,
          name,
          releaseInfo,
        })),
      })),
    ).toEqual([
      {
        type: "movie",
        preset: null,
        total: 2,
        titles: [
          { id: "tt0245429", name: "Spirited Away", releaseInfo: "2001" },
          { id: "tt0119698", name: "Princess Mononoke", releaseInfo: "1997" },
        ],
      },
      { type: "series", preset: null, total: 0, titles: [] },
    ]);
    expect(result.unresolved).toEqual({
      count: 2,
      notCheckedYet: 0,
      entries: [
        { title: "Film introuvable", year: 1987, type: "movie", url: null },
        { title: "Série introuvable", year: 2004, type: "series", url: null },
      ],
    });
    expect(result.withoutDetails).toBe(0);

    // The resolver remembers both outcomes; unresolved ones wait for a retry.
    const rows = await getResolverRows("senscritique", PREVIEW_PRODUCT_IDS);
    expect(
      rows.map(({ external_id, imdb_id, strategy }) => ({
        external_id,
        imdb_id,
        strategy,
      })),
    ).toEqual([
      {
        external_id: "990000101",
        imdb_id: "tt0245429",
        strategy: "wikidata-senscritique",
      },
      { external_id: "990000102", imdb_id: null, strategy: null },
      {
        external_id: "990000103",
        imdb_id: "tt0119698",
        strategy: "wikidata-senscritique",
      },
      { external_id: "990000104", imdb_id: null, strategy: null },
    ]);
    for (const row of rows.filter((entry) => entry.imdb_id === null)) {
      expect(
        Date.parse(present(row.retry_after, "the retry date")),
      ).toBeGreaterThan(Date.now());
    }
  },
);

test(
  "a preview follows the sort, Show and presets of the List",
  { tag: "@local" },
  async () => {
    const result = previewOk(
      await preview(backend.api, {
        provider: "senscritique",
        sourceRef: PUBLIC_REF,
        sortOption: "title-asc",
        displayMode: "movie",
        catalogSettings: { presets: ["rated"] },
      }),
    );

    expect(
      result.catalogs.map(({ type, preset, titles }) => ({
        type,
        preset,
        names: titles.map((title) => title.name),
      })),
    ).toEqual([
      {
        type: "movie",
        preset: null,
        names: ["Princess Mononoke", "Spirited Away"],
      },
      // Top rated sorts by IMDb rating, whatever the saved sort.
      {
        type: "movie",
        preset: "rated",
        names: ["Spirited Away", "Princess Mononoke"],
      },
    ]);
  },
);

test(
  "a private Source list is an expected problem",
  { tag: "@local" },
  async () => {
    expect(
      await preview(backend.api, {
        provider: "senscritique",
        sourceRef: PRIVATE_REF,
      }),
    ).toEqual({ ok: false, reason: "private" });
  },
);

test(
  "a preview of a saved List writes no Catalog cache or sync status and changes no List",
  { tag: "@local" },
  async () => {
    const {
      accountId,
      listIds: [listId],
    } = await seedAccountWithLists([ANIMATION_LIST]);
    const before = await getListRows(accountId);

    previewOk(
      await preview(backend.api, {
        accountKey: accountId,
        provider: "senscritique",
        sourceRef: PUBLIC_REF,
        sortOption: "rating-desc",
      }),
    );

    expect(await countCacheObjects(listId)).toBe(0);
    // A preview is not a refresh: the List keeps no sync status.
    expect(await getSyncStatusRows(listId)).toEqual([]);
    expect(await getListRows(accountId)).toEqual(before);
  },
);

test(
  "a Legacy alias never previews through a Connection",
  { tag: "@local" },
  async ({ request }) => {
    const accountId = await seedAccount({
      legacyImdbUserId: CATALOG_FIXTURE_USER,
    });
    await seedConnection(accountId, "trakt");

    for (const accountKey of [CATALOG_FIXTURE_USER, undefined]) {
      expect(
        await preview(api, {
          accountKey,
          provider: "trakt",
          sourceRef: "me/history",
        }),
      ).toEqual({ ok: false, reason: "needs_connection" });
    }

    const malformed = await request.post(`${BACKEND_URL}/lists/preview`, {
      data: { provider: "netflix", sourceRef: "x", sortOption: "title-asc" },
    });
    expect(malformed.status()).toBe(400);
  },
);

test(
  "an invalid Letterboxd reference is refused without a read",
  { tag: "@local" },
  async () => {
    expect(
      await preview(api, {
        provider: "letterboxd",
        sourceRef: "someone/list/favorites",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  },
);

/** Send the page's previews to the fixture backend. */
async function routePreviews(page: Page) {
  await page.route(`${BACKEND_URL}/lists/preview`, async (route) => {
    const response = await route.fetch({ url: `${backend.url}/lists/preview` });
    await route.fulfill({ response });
  });
}

test(
  "the configure page shows the titles and Unresolved entries of a List",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccountWithLists([
      ANIMATION_LIST,
      {
        provider: "senscritique",
        sourceRef: PRIVATE_REF,
        catalogTitle: "Private fixture",
      },
    ]);
    await routePreviews(page);
    await page.goto(configureUrl(accountId));

    await page
      .getByRole("button", { name: "Preview Animation fixture" })
      .click();
    for (const name of ["Spirited Away (2001)", "Princess Mononoke (1997)"]) {
      await expect(
        page.getByRole("link", { name: `${name}, on IMDb` }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("heading", { name: /^Titles not found/ }),
    ).toBeVisible();
    await expect(page.getByText("Film introuvable")).toBeVisible();
    await expect(page.getByText("Série introuvable")).toBeVisible();

    await page.getByRole("button", { name: "Preview Private fixture" }).click();
    await expect(
      page.getByText(
        "This SensCritique list is private. Make it public on SensCritique.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
  },
);

/** A movie of the long fixture Catalog: its position names it. */
function longTitle(index: number): PreviewTitle {
  const id = `tt99${String(index + 1).padStart(5, "0")}`;
  return {
    id,
    type: "movie",
    name: `Long fixture ${index + 1}`,
    poster: null,
    releaseInfo: "2001",
  };
}

test(
  "the more tile opens every Title of a Catalog, one page at a time",
  { tag: "@local" },
  async ({ page }) => {
    // 130 movies: the preview shows 12, then pages of 60 from offsets 12
    // and 72. The handlers have their own tests; this checks the page.
    const total = 130;
    const { accountId } = await seedAccountWithLists([ANIMATION_LIST]);
    const answer: CatalogPreview = {
      ok: true,
      titleCount: total,
      typeCounts: { movie: total, series: 0 },
      catalogs: [
        {
          type: "movie",
          preset: null,
          total,
          titles: Array.from({ length: 12 }, (_, index) => longTitle(index)),
        },
      ],
      unresolved: { count: 0, notCheckedYet: 0, entries: [] },
      withoutDetails: 0,
    };
    // The previews after the first wait for `release`.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let previews = 0;
    await page.route(`${BACKEND_URL}/lists/preview`, async (route) => {
      previews += 1;
      if (previews > 1) await held;
      await route.fulfill({ json: answer });
    });
    const pageRequests: { offset: unknown; catalog: unknown }[] = [];
    await page.route(`${BACKEND_URL}/lists/preview/titles`, async (route) => {
      const body: unknown = route.request().postDataJSON();
      if (!isRecord(body)) throw new Error("A page request needs a body");
      const { offset, catalog, sourceRef } = body;
      expect(sourceRef).toBe(PUBLIC_REF);
      pageRequests.push({ offset, catalog });
      const start = Number(offset);
      const json: CatalogTitlesPage = {
        ok: true,
        total,
        titles: Array.from(
          { length: Math.max(0, Math.min(60, total - start)) },
          (_, index) => longTitle(start + index),
        ),
      };
      await route.fulfill({ json });
    });
    await page.goto(configureUrl(accountId));

    await page
      .getByRole("button", { name: "Preview Animation fixture" })
      .click();
    await expect(
      page.getByRole("link", { name: "Long fixture 12 (2001), on IMDb" }),
    ).toBeVisible();
    expect(pageRequests).toEqual([]);
    await page
      .getByRole("button", { name: "Show all 130 movies of this catalog" })
      .click();

    const dialog = page.getByRole("dialog", { name: "Animation fixture" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Movies · 130 titles")).toBeVisible();
    // The first page comes at once, the next one on scroll.
    await expect(
      dialog.getByRole("link", { name: "Long fixture 72 (2001), on IMDb" }),
    ).toBeAttached();
    const last = dialog.getByRole("link", {
      name: "Long fixture 130 (2001), on IMDb",
    });
    await expect(last).toHaveCount(0);
    await dialog
      .getByRole("link", { name: "Long fixture 72 (2001), on IMDb" })
      .scrollIntoViewIfNeeded();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    await expect(dialog.getByRole("listitem")).toHaveCount(total);
    expect(pageRequests).toEqual([
      { offset: 12, catalog: { type: "movie", preset: null } },
      { offset: 72, catalog: { type: "movie", preset: null } },
    ]);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const showAll = page.getByRole("button", {
      name: "Show all 130 movies of this catalog",
    });
    await expect(showAll).toBeFocused();

    // While a new sort updates the preview, the rows on screen are from the
    // old one: their pages would not follow on.
    await page.getByRole("combobox", { name: "Sort order" }).click();
    await page
      .getByRole("option", { name: "IMDb Rating (Highest First)" })
      .click();
    await expect(showAll).toBeDisabled();
    release();
    await expect(showAll).toBeEnabled();
  },
);

test(
  "a live IMDb list previews its first Titles",
  { tag: "@live-regression" },
  async () => {
    const result = previewOk(
      await preview(api, { provider: "imdb", sourceRef: PUBLIC_LIST }),
    );

    expect(result.titleCount).toBe(
      result.typeCounts.movie + result.typeCounts.series,
    );
    expect(result.titleCount).toBeGreaterThan(12);
    const [movies, series] = result.catalogs;
    expect(movies).toMatchObject({ type: "movie", preset: null });
    expect(series).toMatchObject({ type: "series", preset: null });
    expect(movies.total).toBe(result.typeCounts.movie);
    expect(movies.titles).toHaveLength(Math.min(12, movies.total));
    for (const title of [...movies.titles, ...series.titles]) {
      expect(title.id).toMatch(/^tt\d+$/);
    }
    // IMDb gives every entry its IMDb ID.
    expect(result.unresolved.count).toBe(0);
  },
);
