import { expect, test } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";
import {
  getConfig,
  isCatalog,
  isManifest,
  isMetaAnswer,
} from "../helpers/api.js";
import { CATALOG_TITLES } from "../helpers/catalog-fixture.js";
import { configureUrl } from "../helpers/configure.js";
import {
  getAccountByLegacyAlias,
  getListRows,
  resetDb,
  seedAccount,
  seedList,
} from "../helpers/db.js";
import { parsed } from "../helpers/json.js";
import { seedCachedCatalog } from "../helpers/r2.js";

// v1 installs keep their Addon URL key (the Legacy alias). Production holds
// these key forms; each one must still serve Stremio and its configure page.
// The Lists are seeded with a fresh cache, so no request reads IMDb.

const LEGACY_KEYS = [
  ["an IMDb user ID", "ur9999999999995"],
  ["a short IMDb user ID", "ur97"],
  ["a p. handle", "p.stremlistE2eHandle01"],
  ["an IMDb list ID", "ls9999999999995"],
  ["a ur ID with letters", "ur9999999999994ls9999999999994"],
] as const;

const JUNK_KEYS = ["123", "potato", "YOUR_IMDB_ID", "ur9999999999993'--"];

const MOVIE_IDS = CATALOG_TITLES.filter((meta) => meta.type === "movie").map(
  (meta) => meta.id,
);

/** A v1 install keyed by `key` whose one List has a cached catalog. */
async function seedLegacyInstall(key: string) {
  const accountId = await seedAccount({ legacyImdbUserId: key });
  const listId = await seedList(accountId, {
    sourceRef: key,
    catalogTitle: "Legacy QA",
    position: 0,
    displayMode: "split",
  });
  await seedCachedCatalog(listId, CATALOG_TITLES);
  return { accountId, listId };
}

test.beforeEach(async () => {
  await resetDb();
});

for (const [label, key] of LEGACY_KEYS) {
  test(
    `a v1 install keyed by ${label} serves Stremio and its configure page`,
    { tag: "@local" },
    async ({ request }) => {
      const { listId } = await seedLegacyInstall(key);
      const base = `${BACKEND_URL}/${encodeURIComponent(key)}`;

      const manifestResponse = await request.get(`${base}/manifest.json`);
      expect(manifestResponse.status()).toBe(200);
      const manifest = parsed(
        await manifestResponse.json(),
        isManifest,
        "manifest",
      );
      expect(manifest.id).toBe(`com.stremlist.${key}`);
      expect(manifest.behaviorHints.configurationRequired).toBe(false);
      expect(manifest.catalogs.map((catalog) => catalog.id)).toEqual([
        `wl-${listId}-movie`,
        `wl-${listId}-series`,
      ]);

      const catalog = await request.get(
        `${base}/catalog/movie/wl-${listId}-movie.json`,
      );
      expect(catalog.status()).toBe(200);
      const { metas } = parsed(await catalog.json(), isCatalog, "catalog");
      expect(metas.map((meta) => meta.id).sort()).toEqual(
        [...MOVIE_IDS].sort(),
      );

      const meta = await request.get(`${base}/meta/movie/${MOVIE_IDS[0]}.json`);
      expect(parsed(await meta.json(), isMetaAnswer, "meta").meta?.id).toBe(
        MOVIE_IDS[0],
      );

      const configure = await request.get(`${base}/configure`, {
        maxRedirects: 0,
      });
      expect(configure.status()).toBe(302);
      expect(configure.headers().location).toBe(
        `${FRONTEND_URL}/configure?account=${encodeURIComponent(key)}`,
      );

      const config = await getConfig(key);
      expect(config.status).toBe(200);
      expect(config.body).toMatchObject({ access: "legacy", accountId: null });
      expect(config.body.lists.map((list) => list.id)).toEqual([listId]);
    },
  );
}

test(
  "junk v1 keys are not found and create nothing",
  { tag: "@local" },
  async ({ request }) => {
    for (const key of JUNK_KEYS) {
      const response = await request.get(
        `${BACKEND_URL}/${encodeURIComponent(key)}/manifest.json`,
      );
      expect(response.status(), key).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        behaviorHints: { configurationRequired: true },
      });
      expect(await getAccountByLegacyAlias(key), key).toBeNull();
    }
  },
);

for (const [label, key, link] of [
  [
    "IMDb ID",
    "ur9999999999995",
    "https://www.imdb.com/user/ur9999999999995/watchlist",
  ],
  [
    "p. handle",
    "p.stremlistE2eHandle01",
    "https://www.imdb.com/user/p.stremlistE2eHandle01/",
  ],
] as const) {
  test(
    `a v1 user who pastes their ${label} on Home lands on their install`,
    { tag: "@local" },
    async ({ page }) => {
      const { accountId, listId } = await seedLegacyInstall(key);
      let creates = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/accounts"))
          creates++;
      });
      await page.goto(FRONTEND_URL);
      await page.getByLabel("Paste a link to a watchlist or list").fill(link);
      await page.getByRole("button", { name: "Add this list" }).click();
      await page.getByRole("button", { name: "Open my Stremlist" }).click();

      await expect(page).toHaveURL(configureUrl(key));
      await expect(
        page.getByText(`Installed with IMDb user ID ${key}`),
      ).toBeVisible();
      await expect(page.getByText("Legacy QA", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "Found your install. It still works.",
        }),
      ).toBeVisible();
      expect(creates).toBe(0);
      // The install is unchanged and no other Account answers to the key.
      expect((await getAccountByLegacyAlias(key))?.id).toBe(accountId);
      expect((await getListRows(accountId)).map((row) => row.id)).toEqual([
        listId,
      ]);
    },
  );
}

test(
  "a v1 p. handle Addon URL pasted on Home opens its install",
  { tag: "@local" },
  async ({ page }) => {
    const key = "p.stremlistE2eHandle01";
    await seedLegacyInstall(key);
    await page.goto(FRONTEND_URL);
    await page
      .getByLabel("Paste a link to a watchlist or list")
      .fill(`stremio://127.0.0.1:7301/${key}/manifest.json`);
    await expect(page.getByText("Addon URL detected")).toBeVisible();
    await page.getByRole("button", { name: "Add this list" }).click();
    await expect(page).toHaveURL(configureUrl(key));
    await expect(page.getByText("Legacy QA", { exact: true })).toBeVisible();
  },
);
