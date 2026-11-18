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

const IMDB_POSTER = "https://posters.e2e.test/imdb/shawshank.svg";
const TMDB_POSTER = "https://posters.e2e.test/tmdb/shawshank.svg";
const TVDB_POSTER = "https://posters.e2e.test/tvdb/shawshank.svg";
const GODFATHER = "https://posters.e2e.test/imdb/godfather.svg";
const RPDB_POSTER =
  "https://api.ratingposterdb.com/e2e-synthetic-rpdb/imdb/poster-default/tt0111161.jpg?fallback=true";
const NO_KEY = "Until you add a key, Stremlist shows IMDb posters.";
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>';

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

  await expect(screen.getByRole("combobox", "Posters")).toHaveText(/IMDb/);
  await expect(screen.getByLabel(/^RPDB API key/)).not.toBeVisible();
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByRole("link", "The Shawshank Redemption (1994), on IMDb"),
  ).toBeVisible();
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([IMDB_POSTER, GODFATHER]);

  await choose(screen, /^TMDB/);
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([TMDB_POSTER, GODFATHER]);

  await choose(screen, /^TheTVDB/);
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([TVDB_POSTER, GODFATHER]);
  await expect(
    screen.getByRole("link", "TheTVDB", { exact: true }),
  ).toBeVisible();

  await choose(screen, /^RPDB/);
  await expect(screen.getByText(NO_KEY, { exact: false })).toBeVisible();
  await expect
    .poll(() => tilePosters(browser))
    .toEqual([IMDB_POSTER, GODFATHER]);
  await screen.getByLabel(/^RPDB API key/).fill("e2e-synthetic-rpdb");
  await expect
    .poll(async () => (await tilePosters(browser))[0])
    .toBe(RPDB_POSTER);
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
  await expect(saveButton(screen)).toHaveAttribute(
    "title",
    "No changes to save",
  );

  await choose(screen, /^RPDB/);
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
    expect(layout?.whole).toBeLessThan(EXAMPLE_COUNT);
    await browser.evaluate(() => {
      const strip = document.querySelector('ul[aria-label="Example posters"]');
      strip?.scrollTo({ left: strip.scrollWidth });
      return null;
    });
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

async function dragExamples(browser: Browser, distance: number) {
  const point = () =>
    browser.evaluate(() => {
      const element = document.querySelector(
        'ul[aria-label="Example posters"]',
      );
      element?.scrollIntoView({ block: "center" });
      const box = element?.getBoundingClientRect();
      if (!element || !box) return null;
      const x = box.x + box.width - 20;
      const y = box.y + box.height / 2;
      return element.contains(document.elementFromPoint(x, y))
        ? { x, y }
        : null;
    });
  await expect.poll(point).not.toBeNull();
  const strip = await point();
  if (!strip) throw new Error("The example posters do not get the mouse");
  await browser.mouse.move(strip.x, strip.y);
  await browser.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await browser.mouse.move(strip.x - (distance * step) / 10, strip.y);
  }
  await browser.mouse.up();
}

function exampleRest(browser: Browser) {
  return browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      'ul[aria-label="Example posters"]',
    );
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const padding = Number.parseFloat(
      getComputedStyle(element).scrollPaddingLeft,
    );
    return {
      scrolled: element.scrollLeft > 0,
      aligned: Array.from(element.children).some(
        (item) =>
          Math.abs(item.getBoundingClientRect().left - box.left - padding) <= 1,
      ),
      atEnd:
        element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
      snaps: element.style.scrollSnapType === "",
    };
  });
}

async function openExamples(
  app: { open(path: string): Promise<unknown> },
  browser: Browser,
  screen: Screen,
  width: number,
) {
  await browser.setViewport({ width, height: 800 });
  await captureConfig(browser);
  await routePosterImages(browser);
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Examples").tap();
  await expect.poll(() => exampleHosts(browser)).toHaveLength(EXAMPLE_COUNT);
}

test("a mouse drags the example posters, which stop on a poster", async ({
  app,
  browser,
  screen,
}) => {
  await openExamples(app, browser, screen, 1280);
  await dragExamples(browser, 130);
  await expect
    .poll(() => exampleRest(browser))
    .toEqual({ scrolled: true, aligned: true, atEnd: false, snaps: true });
});

test("at 390 px, a drag past the end leaves the last poster whole", async ({
  app,
  browser,
  screen,
}) => {
  await openExamples(app, browser, screen, 390);
  await dragExamples(browser, 320);
  await dragExamples(browser, 320);
  await expect
    .poll(() => exampleRest(browser))
    .toMatchObject({ scrolled: true, atEnd: true, snaps: true });
});
