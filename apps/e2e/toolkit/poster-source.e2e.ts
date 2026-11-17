import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Screen } from "e2e";
import type { PreviewRequest } from "./config-fixture";
import {
  SAVED,
  accountId,
  captureConfig,
  configuration,
  previewOf,
  routePreview,
  saveButton,
} from "./config-fixture";

// The poster source of an Account (STR-106): one choice between IMDb (the
// default), TMDB, TheTVDB and RPDB, with the RPDB key field for RPDB only. The preview
// gives both IMDb and TMDB posters of each Title, so the page switches
// source without a new preview. The backend answers are intercepted;
// tests/poster-source.spec.ts covers the real handlers.

const IMDB_POSTER = "https://posters.e2e.test/imdb/shawshank.svg";
const TMDB_POSTER = "https://posters.e2e.test/tmdb/shawshank.svg";
const TVDB_POSTER = "https://posters.e2e.test/tvdb/shawshank.svg";
const GODFATHER = "https://posters.e2e.test/imdb/godfather.svg";
const RPDB_POSTER =
  "https://api.ratingposterdb.com/e2e-synthetic-rpdb/imdb/poster-default/tt0111161.jpg?fallback=true";
const NO_KEY = "Until you add a key, Stremlist shows IMDb posters.";
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>';

/** Shawshank has both posters, The Godfather only the IMDb one. */
function previewWithPosters(request: PreviewRequest) {
  const preview = previewOf(request);
  for (const row of preview.catalogs) {
    for (const title of row.titles) {
      const shawshank = title.id === "tt0111161";
      title.poster = shawshank ? IMDB_POSTER : GODFATHER;
      title.tmdbPoster = shawshank ? TMDB_POSTER : null;
      title.tvdbPoster = shawshank ? TVDB_POSTER : null;
    }
  }
  return preview;
}

/** Answer every poster image, so no tile falls back after a load error. */
async function routePosterImages(browser: Browser) {
  for (const pattern of [
    "https://posters.e2e.test/**",
    "https://api.ratingposterdb.com/**",
    "https://m.media-amazon.com/**",
    "https://image.tmdb.org/**",
    "https://artworks.thetvdb.com/**",
  ]) {
    await browser.route(pattern, async (route) => {
      await route.fulfill({ body: IMAGE, contentType: "image/svg+xml" });
    });
  }
}

/** The poster URL that the first two tiles of the List preview show. */
function tilePosters(browser: Browser) {
  return browser.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLImageElement>(
        'a[aria-label$=", on IMDb"] img',
      ),
    )
      .slice(0, 2)
      .map((image) => image.getAttribute("src")),
  );
}

/** The hosts of the example posters that show. */
function exampleHosts(browser: Browser) {
  return browser.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLImageElement>(
        'img[alt$=", example poster"]',
      ),
    ).map((image) => new URL(image.src).host),
  );
}

async function choose(screen: Screen, source: RegExp) {
  await screen.getByRole("combobox", "Posters").tap();
  await screen.getByRole("option", source).tap();
}

test("each poster source changes the preview at once, RPDB with its key", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  const requests = await routePreview(browser, previewWithPosters);
  await routePosterImages(browser);
  await app.open(`/configure?account=${accountId}`);

  // Existing Accounts keep IMDb posters, and no key field shows.
  await expect(screen.getByRole("combobox", "Posters")).toHaveText(/IMDb/);
  await expect(screen.getByLabel(/^RPDB API key/)).not.toBeVisible();
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByRole("link", "The Shawshank Redemption (1994), on IMDb"),
  ).toBeVisible();
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([IMDB_POSTER, GODFATHER]);

  // TMDB: the Title without a TMDB poster keeps its IMDb poster.
  await choose(screen, /^TMDB/);
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([TMDB_POSTER, GODFATHER]);

  // TheTVDB, with the attribution that its API terms ask for.
  await choose(screen, /^TheTVDB/);
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([TVDB_POSTER, GODFATHER]);
  await expect(
    screen.getByRole("link", "TheTVDB", { exact: true }),
  ).toBeVisible();

  // RPDB without a key shows IMDb posters until the key is added.
  await choose(screen, /^RPDB/);
  await expect(screen.getByText(NO_KEY, { exact: false })).toBeVisible();
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([IMDB_POSTER, GODFATHER]);
  await screen.getByLabel(/^RPDB API key/).fill("e2e-synthetic-rpdb");
  await expect
    .poll(async () => (await tilePosters(browser))[0])
    .toBe(RPDB_POSTER);
  // The choice is a page setting: no new preview, no reinstall.
  expect(requests).toHaveLength(1);
  await expect(
    screen.getByText("These changes need a reinstall."),
  ).not.toBeVisible();

  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    posterSource: "rpdb",
    rpdbApiKey: "e2e-synthetic-rpdb",
  });
});

test("another source keeps the saved RPDB key", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser, {
    ...configuration,
    posterSource: "tmdb",
    rpdbApiKey: "kept-key",
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("combobox", "Posters")).toHaveText(/TMDB/);
  await expect(screen.getByLabel(/^RPDB API key/)).not.toBeVisible();
  // The loaded choice is not an edit.
  await expect(saveButton(screen)).toHaveAttribute(
    "title",
    "No changes to save",
  );

  await choose(screen, /^RPDB/);
  // The field hides the key: show it to read it.
  await screen.getByRole("button", "Show RPDB API key").tap();
  await expect(screen.getByLabel(/^RPDB API key/)).toHaveValue("kept-key");
  await choose(screen, /^IMDb/);
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions[0]).toMatchObject({
    posterSource: "imdb",
    rpdbApiKey: "kept-key",
  });
});

test("example posters open on request and follow the chosen source", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await routePosterImages(browser);
  await app.open(`/configure?account=${accountId}`);

  const examples = screen.getByRole("button", "Examples");
  await expect(examples).toHaveAttribute("aria-expanded", "false");
  // Closed, no example image loads.
  expect(await exampleHosts(browser)).toEqual([]);

  await examples.tap();
  await expect(examples).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => exampleHosts(browser))
    .toEqual([
      "m.media-amazon.com",
      "m.media-amazon.com",
      "m.media-amazon.com",
    ]);
  await choose(screen, /^TMDB/);
  await expect
    .poll(() => exampleHosts(browser))
    .toEqual(["image.tmdb.org", "image.tmdb.org", "image.tmdb.org"]);
  await choose(screen, /^TheTVDB/);
  await expect
    .poll(() => exampleHosts(browser))
    .toEqual([
      "artworks.thetvdb.com",
      "artworks.thetvdb.com",
      "artworks.thetvdb.com",
    ]);
  await choose(screen, /^RPDB/);
  await expect(
    screen.getByText("Add your RPDB API key to see examples."),
  ).toBeVisible();

  await examples.tap();
  await expect(examples).toHaveAttribute("aria-expanded", "false");
});
