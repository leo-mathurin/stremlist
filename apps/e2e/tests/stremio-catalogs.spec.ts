import { expect, test } from "@playwright/test";
import type { ConfigListInput } from "@stremlist/shared/stremio.types";
import { addonManifestUrl } from "../env.js";
import { getCatalog, getConfig, postConfig } from "../helpers/api.js";
import { resetDb, seedAccountWithLists } from "../helpers/db.js";
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

/** A private Account whose only List is one IMDb Source list. */
async function seedImdbAccount(sourceRef = PUBLIC_USER) {
  const {
    accountId,
    listIds: [listId],
  } = await seedAccountWithLists([
    { sourceRef, catalogTitle: "", displayMode: "split" },
  ]);
  return { accountId, listId, manifestUrl: addonManifestUrl(accountId) };
}

const imdbList = (
  sourceRef: string,
  extra: Partial<ConfigListInput> = {},
): ConfigListInput => ({
  provider: "imdb",
  sourceRef,
  sortOption: "added_at-asc",
  ...extra,
});

test.beforeEach(async () => {
  await resetDb();
});

test(
  "watchlist catalog renders in Discover, in catalog order",
  { tag: "@live-smoke" },
  async ({ page }) => {
    const { accountId, listId, manifestUrl } = await seedImdbAccount();
    const catalogId = `wl-${listId}-movie`;
    const { metas } = await getCatalog(accountId, "movie", catalogId);
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
    const { accountId, listId, manifestUrl } = await seedImdbAccount();
    const catalogId = `wl-${listId}-movie`;
    await getCatalog(accountId, "movie", catalogId);
    await installAddon(page, manifestUrl);

    await postConfig(accountId, [
      imdbList(PUBLIC_USER, { id: listId, sortOption: "title-asc" }),
    ]);
    const { metas } = await getCatalog(accountId, "movie", catalogId);
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
    const { accountId, listId, manifestUrl } = await seedImdbAccount();
    await installAddon(page, manifestUrl);

    // Adding a List changes the manifest, which Stremio only picks up on
    // reinstall — exactly what the configure page tells the user to do.
    await postConfig(accountId, [
      imdbList(PUBLIC_USER, { id: listId }),
      imdbList("imdb:box-office", { displayMode: "movie" }),
    ]);
    const { body } = await getConfig(accountId);
    const chart = body.lists.find(
      (list) => list.sourceRef === "imdb:box-office",
    );
    expect(chart).toBeDefined();
    const catalogId = `wl-${chart!.id}-movie`;
    const { metas } = await getCatalog(accountId, "movie", catalogId);
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
    const { accountId, listId, manifestUrl } = await seedImdbAccount();
    // Distinctive title so the Board row is unambiguous.
    await postConfig(accountId, [
      imdbList(PUBLIC_USER, { id: listId, catalogTitle: "E2E QA" }),
    ]);
    await getCatalog(accountId, "movie", `wl-${listId}-movie`);

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
    const { listId, manifestUrl } = await seedImdbAccount(UNKNOWN_USER);
    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", `wl-${listId}-movie`));
    await expect(
      page
        .getByText("IMDb could not find this watchlist", { exact: false })
        .first(),
    ).toBeVisible();
  },
);

test(
  "private watchlist shows the private card in Stremio",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { listId, manifestUrl } = await seedImdbAccount(PRIVATE_USER);
    await installAddon(page, manifestUrl);
    await page.goto(discoverUrl(manifestUrl, "movie", `wl-${listId}-movie`));
    await expect(
      page
        .getByText("This IMDb watchlist is private", { exact: false })
        .first(),
    ).toBeVisible();
  },
);
