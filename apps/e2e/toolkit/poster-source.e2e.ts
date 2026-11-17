import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
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

// The poster source of an Account (STR-106): IMDb by default, or TMDB, with
// an RPDB key over both. The preview gives both posters of each Title, so
// the page switches source without a new preview. The backend answers are
// intercepted; tests/poster-source.spec.ts covers the real handlers.

const IMDB_POSTER = "https://posters.e2e.test/imdb/shawshank.svg";
const TMDB_POSTER = "https://posters.e2e.test/tmdb/shawshank.svg";
const RPDB_POSTER =
  "https://api.ratingposterdb.com/e2e-synthetic-rpdb/imdb/poster-default/tt0111161.jpg?fallback=true";
const TILE = "The Shawshank Redemption (1994), on IMDb";
const POSTER_NOTE = {
  imdb: "Stremlist uses IMDb posters, as before.",
  tmdb: "When TMDB has no poster for a title, or does not answer, Stremlist shows the IMDb poster.",
  rpdb: "Your RPDB key is set, so RPDB posters replace this choice.",
};
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>';

/** The first poster tiles: Shawshank has both posters, The Godfather only IMDb's. */
function previewWithPosters(request: PreviewRequest) {
  const preview = previewOf(request);
  for (const row of preview.catalogs) {
    for (const title of row.titles) {
      if (title.id === "tt0111161") {
        title.poster = IMDB_POSTER;
        title.tmdbPoster = TMDB_POSTER;
      } else {
        title.poster = "https://posters.e2e.test/imdb/godfather.svg";
        title.tmdbPoster = null;
      }
    }
  }
  return preview;
}

/** Answer every poster image, so no tile falls back after a load error. */
async function routePosterImages(browser: Browser) {
  for (const pattern of [
    "https://posters.e2e.test/**",
    "https://api.ratingposterdb.com/**",
  ]) {
    await browser.route(pattern, async (route) => {
      await route.fulfill({ body: IMAGE, contentType: "image/svg+xml" });
    });
  }
}

/** The poster URL that each tile of the first preview shows. */
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

test("the poster source changes the preview at once and saves", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  const requests = await routePreview(browser, previewWithPosters);
  await routePosterImages(browser);
  await app.open(`/configure?account=${accountId}`);

  // Existing Accounts keep IMDb posters.
  await expect(screen.getByRole("radio", /^IMDb/)).toBeChecked();
  await expect(screen.getByText(POSTER_NOTE.imdb)).toBeVisible();
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(screen.getByRole("link", TILE).first()).toBeVisible();
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([IMDB_POSTER, "https://posters.e2e.test/imdb/godfather.svg"]);
  expect(requests).toHaveLength(1);

  // TMDB: the Title without a TMDB poster keeps its IMDb poster.
  await screen.getByRole("radio", /^TMDB/).tap();
  await expect(screen.getByRole("radio", /^TMDB/)).toBeChecked();
  await expect(screen.getByText(POSTER_NOTE.tmdb)).toBeVisible();
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([TMDB_POSTER, "https://posters.e2e.test/imdb/godfather.svg"]);
  // The choice is a page setting: no new preview, no reinstall.
  expect(requests).toHaveLength(1);
  await expect(
    screen.getByText("These changes need a reinstall."),
  ).not.toBeVisible();

  // An RPDB key replaces the chosen source.
  await screen.getByLabel(/^RPDB API key/).fill("e2e-synthetic-rpdb");
  await expect(screen.getByText(POSTER_NOTE.rpdb)).toBeVisible();
  await expect
    .poll(async () => (await tilePosters(browser))[0])
    .toBe(RPDB_POSTER);
  await screen.getByLabel(/^RPDB API key/).fill("");
  await expect
    .poll(async () => (await tilePosters(browser))[0])
    .toBe(TMDB_POSTER);

  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    posterSource: "tmdb",
    rpdbApiKey: "",
  });
});

test("a saved TMDB choice shows again after a reload", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser, {
    ...configuration,
    posterSource: "tmdb",
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("radio", /^TMDB/)).toBeChecked();
  await expect(screen.getByRole("radio", /^IMDb/)).not.toBeChecked();
  // The loaded choice is not an edit.
  await expect(saveButton(screen)).toHaveAttribute(
    "title",
    "No changes to save",
  );

  await screen.getByRole("radio", /^IMDb/).tap();
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions[0]).toMatchObject({ posterSource: "imdb" });
});
