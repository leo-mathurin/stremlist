import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import type { CatalogPreviewResponse } from "@stremlist/shared/catalog-preview";
import {
  BACKEND_URL,
  CONNECTION_ENCRYPTION_KEY,
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../env.js";
import {
  db,
  getListRows,
  resetDb,
  seedAccount,
  seedAccountWithLists,
  seedConnection,
} from "../helpers/db.js";
import {
  PREVIEW_PRIVATE_LIST,
  PREVIEW_PRODUCT_IDS,
  PREVIEW_PUBLIC_LIST,
} from "../helpers/preview-fixture.js";
import { countCacheObjects } from "../helpers/r2.js";
import { CATALOG_FIXTURE_USER, PUBLIC_LIST } from "../helpers/test-data.js";

// The Catalog preview (POST /lists/preview, STR-57) against real handlers.
// A second backend reads a synthetic SensCritique list through the real
// adapter, ID resolver (with its Supabase cache) and IMDb enrichment, with
// only the outbound Provider transport replaced (helpers/preview-transport.ts).
// The standard backend covers the access rules and a live IMDb list.

const PUBLIC_REF = `lists/${PREVIEW_PUBLIC_LIST}`;
const PRIVATE_REF = `lists/${PREVIEW_PRIVATE_LIST}`;

let child: ChildProcess;
let fixtureBackend: string;

test.beforeAll(async () => {
  child = spawn(
    "bun",
    [
      "--no-env-file",
      "--preload",
      fileURLToPath(
        new URL("../helpers/preview-transport.ts", import.meta.url),
      ),
      "src/dev.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../backend/", import.meta.url)),
      // No TMDB key: the TMDB strategy stays off, so only Wikidata resolves.
      env: {
        PATH: process.env.PATH,
        PORT: "0",
        HOST: "127.0.0.1",
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        FRONTEND_URL,
        R2_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        R2_BUCKET,
        CONNECTION_ENCRYPTION_KEY,
        RESEND_API_KEY: "re_fixture_only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  fixtureBackend = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Preview test backend did not start")),
      20_000,
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const port = output.match(
        /backend running on http:\/\/localhost:(\d+)/,
      )?.[1];
      if (port) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Preview backend exited (${code})`));
    });
    child.stderr?.resume();
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      const deadline = setTimeout(() => {
        child.unref();
        reject(new Error("Preview backend did not exit after SIGKILL"));
      }, 6_000);
      child.once("exit", () => {
        clearTimeout(force);
        clearTimeout(deadline);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
});

/** Forget what earlier runs resolved for the synthetic products. */
async function clearResolverCache() {
  const { error } = await db
    .from("title_id_map")
    .delete()
    .eq("namespace", "senscritique")
    .in("external_id", PREVIEW_PRODUCT_IDS);
  if (error) throw error;
}

test.beforeEach(async () => {
  await resetDb();
  await clearResolverCache();
});

async function preview(
  request: APIRequestContext,
  base: string,
  body: Record<string, unknown>,
): Promise<CatalogPreviewResponse> {
  const response = await request.post(`${base}/lists/preview`, {
    data: { sortOption: "added_at-asc", displayMode: "split", ...body },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as CatalogPreviewResponse;
}

function previewOk(result: CatalogPreviewResponse) {
  if (!result.ok) throw new Error(`Preview refused: ${result.reason}`);
  return result;
}

test(
  "a preview resolves the Source list and lists its Unresolved entries",
  { tag: "@local" },
  async ({ request }, testInfo) => {
    // The backend keeps a read for minutes: a retry asks for a list that it
    // did not read yet, so the resolver runs (and writes its cache) again.
    const result = previewOk(
      await preview(request, fixtureBackend, {
        provider: "senscritique",
        sourceRef: `lists/${PREVIEW_PUBLIC_LIST + 100 + testInfo.retry}`,
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
    const { data: rows, error } = await db
      .from("title_id_map")
      .select("external_id, imdb_id, strategy, retry_after")
      .eq("namespace", "senscritique")
      .in("external_id", PREVIEW_PRODUCT_IDS)
      .order("external_id");
    expect(error).toBeNull();
    expect(
      rows!.map(({ external_id, imdb_id, strategy }) => ({
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
    for (const row of rows!.filter((entry) => entry.imdb_id === null)) {
      expect(Date.parse(row.retry_after!)).toBeGreaterThan(Date.now());
    }
  },
);

test(
  "a preview follows the sort, Show and presets of the List",
  { tag: "@local" },
  async ({ request }) => {
    const result = previewOk(
      await preview(request, fixtureBackend, {
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
  async ({ request }) => {
    expect(
      await preview(request, fixtureBackend, {
        provider: "senscritique",
        sourceRef: PRIVATE_REF,
      }),
    ).toEqual({ ok: false, reason: "private" });
  },
);

test(
  "a preview of a saved List writes no Catalog cache and changes no List",
  { tag: "@local" },
  async ({ request }) => {
    const {
      accountId,
      listIds: [listId],
    } = await seedAccountWithLists([
      {
        provider: "senscritique",
        sourceRef: PUBLIC_REF,
        catalogTitle: "Animation fixture",
      },
    ]);
    const before = await getListRows(accountId);

    previewOk(
      await preview(request, fixtureBackend, {
        accountKey: accountId,
        provider: "senscritique",
        sourceRef: PUBLIC_REF,
        sortOption: "rating-desc",
      }),
    );

    expect(await countCacheObjects(listId)).toBe(0);
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

    expect(
      await preview(request, BACKEND_URL, {
        accountKey: CATALOG_FIXTURE_USER,
        provider: "trakt",
        sourceRef: "me/history",
      }),
    ).toEqual({ ok: false, reason: "needs_connection" });
    expect(
      await preview(request, BACKEND_URL, {
        provider: "trakt",
        sourceRef: "me/history",
      }),
    ).toEqual({ ok: false, reason: "needs_connection" });

    const malformed = await request.post(`${BACKEND_URL}/lists/preview`, {
      data: { provider: "netflix", sourceRef: "x", sortOption: "title-asc" },
    });
    expect(malformed.status()).toBe(400);
  },
);

/**
 * Send the page's previews to the fixture backend. With `failFirst`, the
 * first preview fails like a network error.
 */
async function routePreviews(
  page: Page,
  options: { failFirst?: boolean } = {},
) {
  let calls = 0;
  await page.route(`${BACKEND_URL}/lists/preview`, async (route) => {
    calls += 1;
    if (options.failFirst && calls === 1) {
      await route.abort();
      return;
    }
    const response = await route.fetch({
      url: `${fixtureBackend}/lists/preview`,
    });
    await route.fulfill({ response });
  });
  return () => calls;
}

test(
  "the configure page shows the titles and Unresolved entries of a List",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccountWithLists([
      {
        provider: "senscritique",
        sourceRef: PUBLIC_REF,
        catalogTitle: "Animation fixture",
      },
      {
        provider: "senscritique",
        sourceRef: PRIVATE_REF,
        catalogTitle: "Private fixture",
      },
    ]);
    await routePreviews(page);
    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);

    await page
      .getByRole("button", { name: "Preview Animation fixture" })
      .click();
    await expect(
      page.getByRole("link", { name: "Spirited Away (2001), on IMDb" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Princess Mononoke (1997), on IMDb" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Unresolved entries/ }),
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

test(
  "a failed preview recovers with Try again",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccountWithLists([
      {
        provider: "senscritique",
        sourceRef: PUBLIC_REF,
        catalogTitle: "Animation fixture",
      },
    ]);
    const calls = await routePreviews(page, { failFirst: true });
    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);

    await page
      .getByRole("button", { name: "Preview Animation fixture" })
      .click();
    await expect(
      page.getByText(
        "Could not load the preview. Check your connection and try again.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("link", { name: "Spirited Away (2001), on IMDb" }),
    ).toBeVisible();
    expect(calls()).toBe(2);
  },
);

test(
  "a live IMDb list previews its first Titles",
  { tag: "@live-regression" },
  async ({ request }) => {
    const result = previewOk(
      await preview(request, BACKEND_URL, {
        provider: "imdb",
        sourceRef: PUBLIC_LIST,
      }),
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
