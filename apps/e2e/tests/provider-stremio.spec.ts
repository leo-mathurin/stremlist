import { expect, test } from "@playwright/test";
import type { ProviderId } from "@stremlist/shared/providers";
import { FRONTEND_URL } from "../env.js";
import type { Api } from "../helpers/api.js";
import { hasAccountId, listInput, ok } from "../helpers/api.js";
import { configureUrl, saveButton, SAVE_NEW } from "../helpers/configure.js";
import {
  clearResolverCache,
  resetDb,
  seedAccount,
  seedConnection,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { parsed } from "../helpers/json.js";
import { routePageTo } from "../helpers/page-backend.js";
import {
  discoverItemTitles,
  discoverUrl,
  installAddon,
} from "../helpers/stremio.js";

// The path from a Provider to Stremio, for every Provider other than IMDb
// (tests/stremio-*.spec.ts cover IMDb with live data). A fixture backend runs
// the real adapters, database and R2 store; helpers/provider-fixtures.ts
// answers every Provider request. Stremio reads what the manifest declares:
// the Catalogs of each List, then the meta and the streams of a Title.

let backend: FixtureBackend;

/** What every fixture Source list holds: one movie and one series. */
const MOVIE = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
};
const SERIES = { id: "tt0903747", type: "series", name: "Breaking Bad" };

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider-fixtures.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
  // The ID resolver caches SensCritique and Letterboxd products across runs.
  await clearResolverCache("senscritique", ["101", "202"]);
  await clearResolverCache("letterboxd", ["film:101", "film:202"]);
});

/** The order of `sort()` without a compare function: by UTF-16 code units. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read one List as Stremio does. The manifest declares a movie and a series
 * Catalog for it; each Catalog serves the fixture Title of its type.
 * Returns the two Catalog IDs.
 */
async function expectListInStremio(
  api: Api,
  accountKey: string,
  listId: string,
): Promise<{ movie: string; series: string }> {
  const manifest = await api.getManifest(accountKey);
  expect(manifest.behaviorHints.configurationRequired).toBe(false);
  const own = manifest.catalogs.filter((catalog) =>
    catalog.id.startsWith(`wl-${listId}-`),
  );
  expect(
    own
      .map((catalog) => [catalog.type, catalog.id])
      .sort((a, b) => byCodeUnits(a.join(), b.join())),
  ).toEqual([
    ["movie", `wl-${listId}-movie`],
    ["series", `wl-${listId}-series`],
  ]);
  for (const catalog of own) {
    expect(catalog.name).toMatch(/^Stremlist/);
    const { status, metas } = await api.getCatalog(
      accountKey,
      catalog.type,
      catalog.id,
    );
    expect(status).toBe(200);
    expect(metas.map(({ id, type, name }) => ({ id, type, name }))).toEqual([
      catalog.type === "movie" ? MOVIE : SERIES,
    ]);
  }
  return { movie: `wl-${listId}-movie`, series: `wl-${listId}-series` };
}

/**
 * Stremio asks the addon for meta (movies only, `tt` IDs) and streams. Movie
 * meta comes from the Catalog cache. Series meta is delegated to another
 * addon. Without Actions there are no streams and no stream resource.
 */
async function expectMetaAndStreams(api: Api, accountKey: string) {
  const manifest = await api.getManifest(accountKey);
  const resources = manifest.resources.map((resource) =>
    typeof resource === "string" ? resource : resource.name,
  );
  expect(resources).toEqual(["catalog", "meta"]);

  const movie = await api.getMeta(accountKey, "movie", MOVIE.id);
  expect(movie.status).toBe(200);
  expect(movie.meta).toMatchObject({ id: MOVIE.id, name: MOVIE.name });
  expect((await api.getMeta(accountKey, "series", SERIES.id)).meta).toBeNull();
  expect(
    (await api.getMeta(accountKey, "movie", "tt9999999999")).meta,
  ).toBeNull();

  for (const title of [MOVIE, SERIES]) {
    expect(ok(await api.getStreams(accountKey, title.type, title.id))).toEqual({
      streams: [],
      cacheMaxAge: 0,
    });
  }
}

/** One Source list of every Provider except IMDb, in one Account. */
const EVERY_PROVIDER: [ProviderId, string, string][] = [
  ["trakt", "users/fixture-user/watchlist", "Trakt watchlist"],
  ["trakt", "trending", "Trakt trending"],
  ["simkl", "me/plantowatch", "Simkl plan to watch"],
  ["mdblist", "lists/4242", "MDBList weekend"],
  ["justwatch", "tl-us-11111111-2222-4333-8444-555555555555", "JustWatch"],
  ["senscritique", "users/fixture-user/wishes", "SensCritique"],
  ["letterboxd", "users/fixture_user/watchlist", "Letterboxd"],
];

/** Save `EVERY_PROVIDER` in a private Account with Simkl and MDBList connected. */
async function seedEveryProvider() {
  const accountId = await seedAccount();
  await seedConnection(accountId, "simkl");
  await seedConnection(accountId, "mdblist");
  ok(
    await backend.api.postConfig(
      accountId,
      EVERY_PROVIDER.map(([provider, sourceRef, catalogTitle]) =>
        listInput(provider, sourceRef, { catalogTitle, displayMode: "split" }),
      ),
    ),
  );
  const { lists } = ok(await backend.api.getConfig(accountId));
  expect(lists.map((list) => [list.provider, list.sourceRef])).toEqual(
    EVERY_PROVIDER.map(([provider, sourceRef]) => [provider, sourceRef]),
  );
  return { accountId, lists };
}

test(
  "Stremio reads the Catalogs, meta and streams of a List of every Provider",
  { tag: "@local" },
  async () => {
    const { accountId, lists } = await seedEveryProvider();
    for (const list of lists) {
      await expectListInStremio(backend.api, accountId, list.id);
    }
    await expectMetaAndStreams(backend.api, accountId);
  },
);

/** Public links that a visitor pastes on Home, with what they save. */
const HOME_LINKS: [ProviderId, string, string][] = [
  [
    "trakt",
    "https://trakt.tv/users/fixture-user/watchlist",
    "users/fixture-user/watchlist",
  ],
  [
    "justwatch",
    "https://www.justwatch.com/us/lists/tl-us-11111111-2222-4333-8444-555555555555",
    "tl-us-11111111-2222-4333-8444-555555555555",
  ],
  [
    "senscritique",
    "https://www.senscritique.com/fixture-user/collection?action=WISH",
    "users/fixture-user/wishes",
  ],
  [
    "letterboxd",
    "https://letterboxd.com/fixture_user/watchlist/",
    "users/fixture_user/watchlist",
  ],
];

for (const [provider, link, sourceRef] of HOME_LINKS) {
  test(
    `a ${provider} link pasted on Home is saved and served to Stremio`,
    { tag: "@local" },
    async ({ page }) => {
      await routePageTo(page, backend.url);
      await page.goto(FRONTEND_URL);
      await page.getByLabel("Paste a link to a watchlist or list").fill(link);
      await page.getByRole("button", { name: "Add this list" }).click();
      await expect(page).toHaveURL(`${FRONTEND_URL}/configure`);

      // The List is added once the link resolves; then the setup can save.
      const save = saveButton(page, SAVE_NEW);
      await expect(save).toBeEnabled();
      const created = page.waitForResponse(
        (res) =>
          res.url().endsWith("/accounts") && res.request().method() === "POST",
      );
      await save.click();
      const response = await created;
      expect(response.status()).toBe(200);
      const { accountId } = parsed(
        await response.json(),
        hasAccountId,
        "the save answer",
      );
      await expect(page).toHaveURL(configureUrl(accountId));

      const { lists } = ok(await backend.api.getConfig(accountId));
      expect(lists).toMatchObject([{ provider, sourceRef }]);
      await expectListInStremio(backend.api, accountId, lists[0].id);
      await expectMetaAndStreams(backend.api, accountId);

      // The saved List is still there after a reload.
      await page.reload();
      await expect(page).toHaveURL(configureUrl(accountId));
      await expect(
        page.getByRole("button", { name: /^Settings for / }),
      ).toHaveCount(1);
    },
  );
}

test(
  "Stremio Web shows the Catalogs of every Provider",
  { tag: "@live-regression" },
  async ({ page }) => {
    test.setTimeout(300_000);
    const { accountId, lists } = await seedEveryProvider();
    const manifestUrl = `${backend.url}/${accountId}/manifest.json`;
    const catalogs = [];
    for (const list of lists) {
      catalogs.push(await expectListInStremio(backend.api, accountId, list.id));
    }

    await installAddon(page, manifestUrl);
    for (const [index, ids] of catalogs.entries()) {
      for (const [type, title] of [
        ["movie", MOVIE],
        ["series", SERIES],
      ] as const) {
        await page.goto(discoverUrl(manifestUrl, type, ids[type]));
        // A hash change keeps the previous Catalog on screen for a moment.
        // Discover also links the selected Title's details ("Show"), so
        // only the fixture Titles count.
        await expect
          .poll(
            async () =>
              (await discoverItemTitles(page)).filter((name) =>
                [MOVIE.name, SERIES.name].includes(name),
              ),
            {
              message: `${lists[index].provider} ${lists[index].sourceRef} ${type}`,
            },
          )
          .toEqual([title.name]);
      }
    }
  },
);
