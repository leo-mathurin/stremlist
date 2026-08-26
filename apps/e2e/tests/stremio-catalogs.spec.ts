import { expect, test } from "@playwright/test";
import { addonManifestUrl } from "../env.js";
import {
  bootstrapUser,
  getCatalog,
  getConfig,
  postConfig,
} from "../helpers/api.js";
import { resetDb } from "../helpers/db.js";
import {
  discoverItemTitles,
  discoverUrl,
  installAddon,
  uninstallAddon,
} from "../helpers/stremio.js";
import {
  PRIVATE_USER,
  PUBLIC_USER,
  UNKNOWN_USER,
} from "../helpers/test-data.js";

// Catalog rendering inside the real Stremio Web app. Expected content is read
// from the addon's own catalog endpoint in the same run, so assertions stay
// deterministic even though the underlying IMDb data is live.

test.beforeEach(async () => {
  await resetDb();
});

test(
  "watchlist catalog renders in Discover, in catalog order",
  { tag: "@live-smoke" },
  async ({ page }) => {
    const config = await bootstrapUser(PUBLIC_USER);
    const watchlist = config.watchlists[0];
    const catalogId = `wl-${watchlist.id}-movie`;
    const manifestUrl = addonManifestUrl(PUBLIC_USER);
    const { metas } = await getCatalog(PUBLIC_USER, "movie", catalogId);
    expect(metas.length).toBeGreaterThan(0);

    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));

    const rendered = await discoverItemTitles(page);
    expect(rendered.length).toBeGreaterThan(0);
    const expected = metas.map((meta) => meta.name);
    expect(rendered.slice(0, Math.min(5, expected.length))).toEqual(
      expected.slice(0, Math.min(5, rendered.length)),
    );
  },
);

test(
  "sort option changes reorder the catalog without reinstalling",
  { tag: "@live-regression" },
  async ({ page }) => {
    const config = await bootstrapUser(PUBLIC_USER);
    const watchlist = config.watchlists[0];
    const catalogId = `wl-${watchlist.id}-movie`;
    const manifestUrl = addonManifestUrl(PUBLIC_USER);
    await getCatalog(PUBLIC_USER, "movie", catalogId);
    await installAddon(page, manifestUrl);

    await postConfig(PUBLIC_USER, [
      {
        id: watchlist.id,
        imdbUserId: watchlist.imdbUserId,
        sortOption: "title-asc",
      },
    ]);
    const { metas } = await getCatalog(PUBLIC_USER, "movie", catalogId);
    const expected = metas.map((meta) => meta.name);
    expect(expected).toEqual([...expected].sort((a, b) => a.localeCompare(b)));

    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));
    const rendered = await discoverItemTitles(page);
    expect(rendered.slice(0, Math.min(5, expected.length))).toEqual(
      expected.slice(0, Math.min(5, rendered.length)),
    );
  },
);

test(
  "built-in chart catalog renders after a reinstall",
  { tag: "@live-regression" },
  async ({ page }) => {
    await bootstrapUser(PUBLIC_USER);
    const manifestUrl = addonManifestUrl(PUBLIC_USER);
    await installAddon(page, manifestUrl);

    // Adding a catalog changes the manifest, which Stremio only picks up on
    // reinstall — exactly what the configure page tells the user to do.
    await postConfig(PUBLIC_USER, [
      { imdbUserId: PUBLIC_USER, sortOption: "added_at-asc" },
      {
        imdbUserId: "imdb:box-office",
        sortOption: "added_at-asc",
        displayMode: "movie",
      },
    ]);
    const { body } = await getConfig(PUBLIC_USER);
    const chart = body.watchlists.find(
      (w) => w.imdbUserId === "imdb:box-office",
    );
    expect(chart).toBeDefined();
    const catalogId = `wl-${chart!.id}-movie`;
    const { metas } = await getCatalog(PUBLIC_USER, "movie", catalogId);
    expect(metas.length).toBeGreaterThan(0);

    await uninstallAddon(page, manifestUrl);
    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));

    const rendered = await discoverItemTitles(page);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered[0]).toBe(metas[0].name);
  },
);

test(
  "catalog rows appear on the Board",
  { tag: "@live-regression" },
  async ({ page }) => {
    const config = await bootstrapUser(PUBLIC_USER);
    const watchlist = config.watchlists[0];
    // Distinctive title so the Board row is unambiguous.
    await postConfig(PUBLIC_USER, [
      {
        id: watchlist.id,
        imdbUserId: watchlist.imdbUserId,
        sortOption: "added_at-asc",
        catalogTitle: "E2E QA",
      },
    ]);
    const manifestUrl = addonManifestUrl(PUBLIC_USER);
    await getCatalog(PUBLIC_USER, "movie", `wl-${watchlist.id}-movie`);

    await installAddon(page, manifestUrl);
    await page.goto("https://web.stremio.com/#/");
    await expect(
      page.getByText("Stremlist E2E QA", { exact: false }).first(),
    ).toBeAttached({ timeout: 30_000 });
  },
);

test(
  "broken watchlist shows the informational card in Stremio",
  { tag: "@live-regression" },
  async ({ page }) => {
    const config = await bootstrapUser(UNKNOWN_USER);
    const catalogId = `wl-${config.watchlists[0].id}-movie`;
    const manifestUrl = addonManifestUrl(UNKNOWN_USER);

    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));
    await expect(
      page.getByText("IMDb watchlist not found", { exact: false }).first(),
    ).toBeVisible();
  },
);

test(
  "private watchlist shows the private card in Stremio",
  { tag: "@live-regression" },
  async ({ page }) => {
    const config = await bootstrapUser(PRIVATE_USER);
    const catalogId = `wl-${config.watchlists[0].id}-movie`;
    const manifestUrl = addonManifestUrl(PRIVATE_USER);

    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", catalogId));
    await expect(
      page
        .getByText("This IMDb watchlist is private", { exact: false })
        .first(),
    ).toBeVisible();
  },
);
