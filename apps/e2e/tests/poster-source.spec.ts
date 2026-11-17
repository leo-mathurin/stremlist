import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Api } from "../helpers/api.js";
import { listInput, ok } from "../helpers/api.js";
import {
  configureUrl,
  fillRpdbKey,
  saveConfigure,
} from "../helpers/configure.js";
import {
  clearTmdbPosters,
  getPosterSource,
  getTmdbPosterRows,
  resetDb,
  seedAccount,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { routePageTo } from "../helpers/page-backend.js";

// The poster source of an Account (STR-106), through the real backend,
// database and caches. helpers/provider-fixtures.ts answers Trakt, IMDb and
// TMDB: Shawshank has a TMDB poster, Breaking Bad has none.

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
  backend = await startFixtureBackend("./provider-fixtures.ts", {
    TMDB_API_KEY: "fixture-tmdb-key",
    E2E_IMDB_POSTERS: "1",
  });
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  await clearTmdbPosters(TITLES);
  backend.clearRequests();
});

/** A private Account with the Trakt fixture watchlist, saved through the API. */
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

/** The poster of each Title that Stremio receives, movie and series Catalogs. */
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

/** Answer poster images locally: the page never reaches IMDb or TMDB. */
async function routePosterImages(page: Page) {
  for (const pattern of [
    "https://m.media-amazon.com/**",
    "https://image.tmdb.org/**",
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({ body: IMAGE, contentType: "image/svg+xml" }),
    );
  }
}

const tmdbRequests = () =>
  backend.requests((url) => url.host === "api.themoviedb.org");

test(
  "a TMDB choice saves, survives a reload and reaches Stremio for this Account only",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId, listId } = await seedWatchlistAccount(backend.api);
    // Existing Accounts keep IMDb posters, and Stremio sees no TMDB poster.
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

    // Stremio: the TMDB poster, and the IMDb poster where TMDB has none.
    expect(await stremioPosters(backend.api, accountId, listId)).toEqual({
      [MOVIE]: TMDB_POSTER,
      [SERIES]: imdbPoster(SERIES),
    });
    expect(
      (await backend.api.getMeta(accountId, "movie", MOVIE)).meta,
    ).toMatchObject({ id: MOVIE, poster: TMDB_POSTER });
    // IMDb IDs and Titles stay the same.
    const { metas } = await backend.api.getCatalog(
      accountId,
      "movie",
      `wl-${listId}-movie`,
    );
    expect(metas.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: MOVIE, name: "The Shawshank Redemption" },
    ]);

    // TMDB answers are stored once for every Account, a missing poster too.
    expect(await getTmdbPosterRows(TITLES)).toEqual([
      { imdb_id: MOVIE, poster_path: "/fixture-shawshank.jpg" },
      { imdb_id: SERIES, poster_path: null },
    ]);
    backend.clearRequests();
    await stremioPosters(backend.api, accountId, listId);
    expect(tmdbRequests()).toEqual([]);

    // Another Account with the same watchlist keeps its own IMDb posters.
    const other = await seedWatchlistAccount(backend.api);
    expect(
      await stremioPosters(backend.api, other.accountId, other.listId),
    ).toEqual({ [MOVIE]: imdbPoster(MOVIE), [SERIES]: imdbPoster(SERIES) });

    // RPDB with a key: Stremio gets RPDB posters.
    await fillRpdbKey(page, "e2e-test-key");
    await saveConfigure(page);
    expect(await getPosterSource(accountId)).toBe("rpdb");
    expect((await stremioPosters(backend.api, accountId, listId))[MOVIE]).toBe(
      `https://api.ratingposterdb.com/e2e-test-key/imdb/poster-default/${MOVIE}.jpg?fallback=true`,
    );

    // Back to TMDB: the key stays saved, unused, and the List is the same.
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
  { tag: "@local" },
  async () => {
    const down = await startFixtureBackend("./provider-fixtures.ts", {
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
      expect(await getTmdbPosterRows(TITLES)).toEqual([]);
    } finally {
      await down.stop();
    }
  },
);
