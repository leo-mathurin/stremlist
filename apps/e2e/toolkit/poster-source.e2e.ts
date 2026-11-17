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

const EXAMPLE_COUNT = 10;

/**
 * How the example posters lie out: the number of rows they take, how many
 * show whole, and how far the page scrolls sideways.
 */
function exampleLayout(browser: Browser) {
  return browser.evaluate(() => {
    const strip = document.querySelector('ul[aria-label="Example posters"]');
    if (!strip) return null;
    const box = strip.getBoundingClientRect();
    const posters = Array.from(strip.children, (item) =>
      item.getBoundingClientRect(),
    );
    return {
      rows: new Set(posters.map((poster) => Math.round(poster.top))).size,
      whole: posters.filter(
        (poster) =>
          poster.left >= box.left - 1 && poster.right <= box.right + 1,
      ).length,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
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
    .toEqual(Array(EXAMPLE_COUNT).fill("m.media-amazon.com"));
  await choose(screen, /^TMDB/);
  await expect
    .poll(() => exampleHosts(browser))
    .toEqual(Array(EXAMPLE_COUNT).fill("image.tmdb.org"));
  await choose(screen, /^TheTVDB/);
  await expect
    .poll(() => exampleHosts(browser))
    .toEqual(Array(EXAMPLE_COUNT).fill("artworks.thetvdb.com"));
  await choose(screen, /^RPDB/);
  await expect(
    screen.getByText("Add your RPDB API key to see examples."),
  ).toBeVisible();

  await examples.tap();
  await expect(examples).toHaveAttribute("aria-expanded", "false");
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width} px, the example posters stay in one row that scrolls`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport(viewport);
    await captureConfig(browser);
    await routePosterImages(browser);
    await app.open(`/configure?account=${accountId}`);

    await screen.getByRole("button", "Examples").tap();
    await expect.poll(() => exampleHosts(browser)).toHaveLength(EXAMPLE_COUNT);
    const layout = await exampleLayout(browser);
    expect(layout?.rows).toBe(1);
    expect(layout?.sideways).toBe(0);
    // Some posters are past the edge; the row scrolls to them.
    expect(layout?.whole).toBeLessThan(EXAMPLE_COUNT);
    await browser.evaluate(() => {
      const strip = document.querySelector('ul[aria-label="Example posters"]');
      strip?.scrollTo({ left: strip.scrollWidth });
      return null;
    });
    // The last poster shows whole at the end of the row.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const strip = document.querySelector(
            'ul[aria-label="Example posters"]',
          );
          const last = strip?.lastElementChild;
          if (!strip || !last) return false;
          const box = strip.getBoundingClientRect();
          return last.getBoundingClientRect().right <= box.right + 1;
        }),
      )
      .toBe(true);
    expect((await exampleLayout(browser))?.sideways).toBe(0);
  });
}

test("a mouse drags the example posters, which stop on a poster", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await captureConfig(browser);
  await routePosterImages(browser);
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Examples").tap();
  await expect.poll(() => exampleHosts(browser)).toHaveLength(EXAMPLE_COUNT);

  const strip = await browser.evaluate(() => {
    const element = document.querySelector('ul[aria-label="Example posters"]');
    element?.scrollIntoView({ block: "center" });
    const box = element?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  });
  if (!strip) throw new Error("The example posters do not show");
  await browser.mouse.move(strip.x, strip.y);
  await browser.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await browser.mouse.move(strip.x - 13 * step, strip.y);
  }
  await browser.mouse.up();

  // The row followed the mouse, then glided until a poster lines up with
  // its start, and snaps again.
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const element = document.querySelector<HTMLElement>(
          'ul[aria-label="Example posters"]',
        );
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const padding = Number.parseFloat(
          getComputedStyle(element).scrollPaddingLeft,
        );
        const aligned = Array.from(element.children).some(
          (item) =>
            Math.abs(item.getBoundingClientRect().left - box.left - padding) <=
            1,
        );
        return {
          scrolled: element.scrollLeft > 0,
          aligned,
          snaps: element.style.scrollSnapType === "",
        };
      }),
    )
    .toEqual({ scrolled: true, aligned: true, snaps: true });
});
