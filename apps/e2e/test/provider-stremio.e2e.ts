import { expect } from "../integration-expect.js";
import { test } from "../integration-browser.js";
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

let backend: FixtureBackend;

const MOVIE = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
};
const SERIES = { id: "tt0903747", type: "series", name: "Breaking Bad" };

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider.fixture.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
  await clearResolverCache("senscritique", ["101", "202"]);
  await clearResolverCache("letterboxd", ["film:101", "film:202"]);
});

function byCodeUnits(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function expectListInStremio(
  api: Api,
  accountKey: string,
  listId: string,
) {
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

const EVERY_PROVIDER: [ProviderId, string, string][] = [
  ["trakt", "users/fixture-user/watchlist", "Trakt watchlist"],
  ["trakt", "trending", "Trakt trending"],
  ["trakt", "users/fixture-user/ratings", "Trakt ratings"],
  ["trakt", "watched", "Trakt most watched"],
  ["simkl", "me/plantowatch", "Simkl plan to watch"],
  ["mdblist", "lists/4242", "MDBList weekend"],
  ["justwatch", "tl-us-11111111-2222-4333-8444-555555555555", "JustWatch"],
  ["senscritique", "users/fixture-user/wishes", "SensCritique"],
  ["senscritique", "users/fixture-user/done", "SensCritique watched"],
  ["letterboxd", "users/fixture_user/watchlist", "Letterboxd"],
];

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
  { tags: ["local"] },
  async () => {
    const { accountId, lists } = await seedEveryProvider();
    for (const list of lists) {
      await expectListInStremio(backend.api, accountId, list.id);
    }
    await expectMetaAndStreams(backend.api, accountId);
  },
);

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
    { tags: ["local"] },
    async ({ page }) => {
      await routePageTo(page, backend.url);
      await page.goto(FRONTEND_URL);
      await page.getByLabel("Paste a link to a watchlist or list").fill(link);
      await page.getByRole("button", { name: "Add this list" }).click();
      await expect(page).toHaveURL(`${FRONTEND_URL}/configure`);

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
  { tags: ["live-regression"] },
  async ({ page }) => {
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
