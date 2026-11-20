import { expect } from "../integration-expect.js";
import { test } from "../integration-browser.js";
import type { Page } from "../integration-browser.js";
import type { Api } from "../helpers/api.js";
import { listInput, ok } from "../helpers/api.js";
import {
  configureUrl,
  fillRpdbKey,
  saveConfigure,
} from "../helpers/configure.js";
import {
  clearTitlePosters,
  getPosterSource,
  getTitlePosterRows,
  resetDb,
  seedAccount,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { routeToLoopback } from "../helpers/loopback-page.js";
import { routePageTo } from "../helpers/page-backend.js";

const MOVIE = "tt0111161";
const SERIES = "tt0903747";
const TITLES = [MOVIE, SERIES];
const TRAKT_WATCHLIST = "users/fixture-user/watchlist";
const TMDB_POSTER = "https://image.tmdb.org/t/p/w500/fixture-shawshank.jpg";
const TMDB_PREVIEW = "https://image.tmdb.org/t/p/w342/fixture-shawshank.jpg";
const imdbPoster = (id: string) =>
  `https://m.media-amazon.com/images/M/fixture-${id}.jpg`;
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>';

let backend: FixtureBackend;

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider.fixture.ts", {
    TMDB_API_KEY: "fixture-tmdb-key",
    E2E_IMDB_POSTERS: "1",
  });
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  await clearTitlePosters(TITLES);
  backend.clearRequests();
});

async function seedWatchlistAccount(api: Api, options = {}) {
  const accountId = await seedAccount();
  ok(
    await api.postConfig(
      accountId,
      [
        listInput("trakt", TRAKT_WATCHLIST, {
          catalogTitle: "Poster fixture",
          displayMode: "split",
        }),
      ],
      options,
    ),
  );
  const { lists } = ok(await api.getConfig(accountId));
  return { accountId, listId: lists[0].id };
}

async function stremioPosters(api: Api, accountId: string, listId: string) {
  const posters: Record<string, string | null> = {};
  for (const type of ["movie", "series"]) {
    const { status, metas } = await api.getCatalog(
      accountId,
      type,
      `wl-${listId}-${type}`,
    );
    expect(status).toBe(200);
    for (const meta of metas) posters[meta.id] = meta.poster;
  }
  return posters;
}

async function routePosterImages(page: Page) {
  for (const pattern of [
    "https://m.media-amazon.com/**",
    "https://image.tmdb.org/**",
  ]) {
    await routeToLoopback(page, pattern, {
      contentType: "image/svg+xml",
      body: IMAGE,
    });
  }
}

const tmdbRequests = () =>
  backend.requests((url) => url.host === "api.themoviedb.org");

test(
  "a TMDB choice saves, survives a reload and reaches Stremio for this Account only",
  { tags: ["local"] },
  async ({ page }) => {
    const { accountId, listId } = await seedWatchlistAccount(backend.api);
    expect(await getPosterSource(accountId)).toBe("imdb");
    expect(await stremioPosters(backend.api, accountId, listId)).toEqual({
      [MOVIE]: imdbPoster(MOVIE),
      [SERIES]: imdbPoster(SERIES),
    });

    await routePageTo(page, backend.url);
    await routePosterImages(page);
    await page.goto(configureUrl(accountId));
    await expect(
      page.getByText("Poster fixture", { exact: true }),
    ).toBeVisible();
    const posters = page.getByRole("combobox", { name: "Posters" });
    const choose = async (source: RegExp) => {
      await posters.click();
      await page.getByRole("option", { name: source }).click();
    };
    await expect(posters).toHaveText(/IMDb/);
    await expect(page.locator("#rpdb-api-key")).toHaveCount(0);

    await page.getByRole("button", { name: "Preview Poster fixture" }).click();
    const tile = page
      .getByRole("link", { name: /^The Shawshank Redemption/ })
      .locator("img");
    await expect(tile).toHaveAttribute("src", /fixture-tt0111161/);
    await choose(/^TMDB/);
    await expect(tile).toHaveAttribute("src", TMDB_PREVIEW);
    await saveConfigure(page);

    await page.reload();
    await expect(
      page.getByText("Poster fixture", { exact: true }),
    ).toBeVisible();
    await expect(posters).toHaveText(/TMDB/);
    expect(await getPosterSource(accountId)).toBe("tmdb");

    expect(await stremioPosters(backend.api, accountId, listId)).toEqual({
      [MOVIE]: TMDB_POSTER,
      [SERIES]: imdbPoster(SERIES),
    });
    expect(
      (await backend.api.getMeta(accountId, "movie", MOVIE)).meta,
    ).toMatchObject({ id: MOVIE, poster: TMDB_POSTER });
    const { metas } = await backend.api.getCatalog(
      accountId,
      "movie",
      `wl-${listId}-movie`,
    );
    expect(metas.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: MOVIE, name: "The Shawshank Redemption" },
    ]);

    expect(await getTitlePosterRows("tmdb", TITLES)).toEqual([
      { imdb_id: MOVIE, poster: "/fixture-shawshank.jpg" },
      { imdb_id: SERIES, poster: null },
    ]);
    backend.clearRequests();
    await stremioPosters(backend.api, accountId, listId);
    expect(tmdbRequests()).toEqual([]);

    const other = await seedWatchlistAccount(backend.api);
    expect(
      await stremioPosters(backend.api, other.accountId, other.listId),
    ).toEqual({ [MOVIE]: imdbPoster(MOVIE), [SERIES]: imdbPoster(SERIES) });

    await fillRpdbKey(page, "e2e-test-key");
    await saveConfigure(page);
    expect(await getPosterSource(accountId)).toBe("rpdb");
    expect((await stremioPosters(backend.api, accountId, listId))[MOVIE]).toBe(
      `https://api.ratingposterdb.com/e2e-test-key/imdb/poster-default/${MOVIE}.jpg?fallback=true`,
    );

    await choose(/^TMDB/);
    await expect(page.locator("#rpdb-api-key")).toHaveCount(0);
    await saveConfigure(page);
    const saved = ok(await backend.api.getConfig(accountId));
    expect(saved).toMatchObject({
      posterSource: "tmdb",
      rpdbApiKey: "e2e-test-key",
    });
    expect(saved.lists.map((list) => list.id)).toEqual([listId]);
    expect((await stremioPosters(backend.api, accountId, listId))[MOVIE]).toBe(
      TMDB_POSTER,
    );
  },
);

test(
  "while TMDB fails, Stremio keeps the IMDb posters and nothing is stored",
  { tags: ["local"] },
  async () => {
    const down = await startFixtureBackend("./provider.fixture.ts", {
      TMDB_API_KEY: "fixture-tmdb-key",
      E2E_IMDB_POSTERS: "1",
      E2E_TMDB_STATUS: "503",
    });
    try {
      const { accountId, listId } = await seedWatchlistAccount(down.api, {
        posterSource: "tmdb",
      });
      expect(await getPosterSource(accountId)).toBe("tmdb");
      expect(await stremioPosters(down.api, accountId, listId)).toEqual({
        [MOVIE]: imdbPoster(MOVIE),
        [SERIES]: imdbPoster(SERIES),
      });
      expect(
        down.requests((url) => url.host === "api.themoviedb.org").length,
      ).toBeGreaterThan(0);
      expect(await getTitlePosterRows("tmdb", TITLES)).toEqual([]);
    } finally {
      await down.stop();
    }
  },
);

const LIVE_TVDB_KEY = process.env.TVDB_LIVE_API_KEY ?? "";
const TVDB_ARTWORK =
  /^https:\/\/artworks\.thetvdb\.com\/.+\.(?:jpe?g|png|webp)$/u;

test(
  "TheTVDB posters, with the real API, save and reach Stremio",
  { tags: ["local"] },
  async ({ page }) => {
    test.skip(!LIVE_TVDB_KEY, "Needs TVDB_LIVE_API_KEY (a real TheTVDB key)");
    const live = await startFixtureBackend("./provider.fixture.ts", {
      TVDB_API_KEY: LIVE_TVDB_KEY,
      E2E_IMDB_POSTERS: "1",
    });
    try {
      const { accountId, listId } = await seedWatchlistAccount(live.api);
      await routePageTo(page, live.url);
      await routePosterImages(page);
      await page.goto(configureUrl(accountId));
      await expect(
        page.getByText("Poster fixture", { exact: true }),
      ).toBeVisible();

      await page
        .getByRole("button", { name: "Preview Poster fixture" })
        .click();
      const tile = page
        .getByRole("link", { name: /^The Shawshank Redemption/ })
        .locator("img");
      await expect(tile).toHaveAttribute("src", /fixture-tt0111161/);
      const posters = page.getByRole("combobox", { name: "Posters" });
      await posters.click();
      await page.getByRole("option", { name: /^TheTVDB/ }).click();
      await expect(tile).toHaveAttribute(
        "src",
        /^https:\/\/artworks\.thetvdb\.com\/.+_t\.jpe?g$/u,
      );
      await expect(
        page.getByRole("link", { name: "TheTVDB", exact: true }),
      ).toHaveAttribute("href", "https://thetvdb.com/");
      await saveConfigure(page);

      await page.reload();
      await expect(posters).toHaveText(/TheTVDB/);
      expect(await getPosterSource(accountId)).toBe("tvdb");

      const served = await stremioPosters(live.api, accountId, listId);
      expect(served[MOVIE]).toMatch(TVDB_ARTWORK);
      expect(served[SERIES]).toMatch(TVDB_ARTWORK);
      expect(served[MOVIE]).not.toMatch(/_t\.jpe?g$/u);
      expect(
        (await getTitlePosterRows("tvdb", TITLES)).map((row) => row.imdb_id),
      ).toEqual([MOVIE, SERIES]);

      live.clearRequests();
      await stremioPosters(live.api, accountId, listId);
      expect(live.requests((url) => url.host === "api4.thetvdb.com")).toEqual(
        [],
      );
    } finally {
      await live.stop();
    }
  },
);
