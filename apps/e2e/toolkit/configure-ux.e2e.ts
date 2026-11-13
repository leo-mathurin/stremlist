import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  SAVED_REINSTALL,
  SAVE_NEW,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  connected,
  imdbUser,
  legacyConfiguration,
  previewOf,
  resolved,
  routeConnectStart,
  routeConnectionSources,
  routeCreateAccount,
  routeResolve,
  row,
  saveButton,
  syncedStatus,
  toJson,
  isPreviewRequest,
  parseBody,
} from "./config-fixture";

// Configure page feedback: unsaved changes, phone-width feedback, plain
// wording and Connect labels. The API is intercepted.

const PASTE = "Paste a link to a watchlist or list";
const PHONE = { width: 390, height: 844 };
const watchlistLink = `https://www.imdb.com/user/${imdbUser}/watchlist`;

const traktWatchlist = {
  ...row,
  id: "00000000-0000-4000-8000-000000000005",
  provider: "trakt",
  sourceRef: "me/watchlist",
  catalogTitle: "Trakt Watchlist",
  position: 1,
} as const;

/** Whether the first element that `selector` and `text` find is fully in the viewport. */
function inViewport(browser: Browser, selector: string, text: string) {
  return browser.evaluate(
    ([css, wanted]) => {
      const element = [...document.querySelectorAll(css)].find(
        (node) => node.textContent?.trim() === wanted,
      );
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    },
    [selector, text],
  );
}

/** The titles of the List rows, top to bottom. */
function rowTitles(browser: Browser) {
  return browser.evaluate(() =>
    [...document.querySelectorAll("[data-list-row]")].map(
      (row) => row.querySelector("p")?.textContent?.trim() ?? "",
    ),
  );
}

test("unsaved changes ask before the page reloads, and a save clears them", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  const dialogs: string[] = [];
  await browser.onDialog(async (dialog) => {
    dialogs.push(dialog.message);
    await dialog.dismiss();
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();

  // Nothing changed yet: no warning.
  expect(
    await browser.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(true);

  await screen.getByRole("button", "Remove Test catalog").tap();
  await expect(screen.getByText("Test catalog")).toHaveCount(0);
  // A cancelled event is what makes the browser ask before it leaves.
  expect(
    await browser.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(false);

  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();
  await saveButton(screen).tap();
  await expect(screen.getByText(/^Saved!/)).toBeVisible();
  expect(
    await browser.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(true);
  expect(dialogs).toEqual([]);
});

test("Save is off while there is nothing to save", async ({
  app,
  browser,
  screen,
}) => {
  const saves = await captureConfig(browser);
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  const save = saveButton(screen);
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", "No changes to save");

  await screen.getByRole("button", "Settings for Test catalog").tap();
  const title = screen.getByLabel("Catalog title");
  await title.fill("Renamed");
  await expect(save).toBeEnabled();
  // The saved title again: nothing to save.
  await title.fill("Test catalog");
  await expect(save).toBeDisabled();

  await title.fill("Renamed");
  await save.tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await expect(save).toBeDisabled();
  expect(saves).toHaveLength(1);
});

test("Save is off on a v1 install without changes, and on for a new setup", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  await expect(saveButton(screen)).toBeDisabled();

  await app.open("/configure");
  await expect(saveButton(screen, SAVE_NEW)).toBeDisabled();
  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();
  await expect(saveButton(screen, SAVE_NEW)).toBeEnabled();
});

test("leaving the configure page with unsaved changes asks first", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Remove Test catalog").tap();

  await screen.getByRole("link", "Terms").tap();
  const dialog = screen.getByRole("dialog", "Leave without saving?");
  await expect(dialog).toBeVisible();
  await screen.getByRole("button", "Keep editing").tap();
  await expect(dialog).toHaveCount(0);
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  await expect(screen.getByText(/^0 of 10 lists/)).toBeVisible();

  await screen.getByRole("link", "Terms").tap();
  await screen.getByRole("button", "Leave without saving").tap();
  await expect(browser).toHaveURL("/terms");
});

test("on a phone, an added list says so and the install step comes into view after the first save", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(PHONE);
  await baseRoutes(browser);
  await routeResolve(browser, (input) =>
    input === watchlistLink ? resolved("imdb", imdbUser, "watchlist") : null,
  );
  const created = await routeCreateAccount(browser);
  await browser.route(`${backend}/${accountId}/config`, (route) =>
    route.fulfill({
      json: toJson({
        ...configuration,
        lists: [{ ...row, catalogTitle: "IMDb Watchlist" }],
      }),
    }),
  );
  await app.open("/configure");

  await screen.getByLabel(PASTE).fill(watchlistLink);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  // The new row is below the Providers panel, out of view: a toast says what
  // happened and can show it.
  await expect(screen.getByText("Added IMDb Watchlist")).toBeVisible();
  expect(await inViewport(browser, "p", "IMDb Watchlist")).toBe(false);
  await screen.getByRole("button", "Show", { exact: true }).tap();
  await expect
    .poll(() => inViewport(browser, "p", "IMDb Watchlist"))
    .toBe(true);

  await saveButton(screen, SAVE_NEW).tap();
  await expect(
    screen.getByRole("heading", "Your Stremlist is ready"),
  ).toBeVisible();
  await expect
    .poll(() => inViewport(browser, "h3", "Your Stremlist is ready"))
    .toBe(true);
  expect(created).toHaveLength(1);
});

test("a new list goes first: in view on a wide screen, and a toast can show it on a phone", async ({
  app,
  browser,
  screen,
}) => {
  const listLink = "https://www.imdb.com/list/ls99123456/";
  await captureConfig(browser);
  await routeResolve(browser, (input) =>
    input === listLink ? resolved("imdb", "ls99123456", "list") : null,
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  await screen.getByLabel(PASTE).fill(listLink);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("IMDb · List · ls99123456")).toBeVisible();
  expect(await rowTitles(browser)).toEqual(["IMDb List", "Test catalog"]);
  // The new row shows at the top of the lists: no toast is needed.
  expect(await inViewport(browser, "p", "IMDb List")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect(screen.getByText("Added IMDb List")).toBeHidden();

  // On a phone, Quick add is below the lists: the new first row is above
  // the screen, so a toast says so and shows it.
  await browser.setViewport(PHONE);
  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();
  await expect(screen.getByText("Added Top 250 Movies")).toBeVisible();
  expect(await inViewport(browser, "p", "Top 250 Movies")).toBe(false);
  await screen.getByRole("button", "Show", { exact: true }).tap();
  await expect
    .poll(() => inViewport(browser, "p", "Top 250 Movies"))
    .toBe(true);
  expect(await rowTitles(browser)).toEqual([
    "Top 250 Movies",
    "IMDb List",
    "Test catalog",
  ]);
});

test("a list whose Provider was never connected offers Connect, and an expired one Connect again", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(PHONE);
  const traktList = {
    ...traktWatchlist,
    id: "00000000-0000-4000-8000-000000000006",
    sourceRef: "me/history",
    catalogTitle: "Trakt History",
  };
  await captureConfig(browser, {
    ...configuration,
    lists: [row, traktList],
    syncStatus: {
      ...configuration.syncStatus,
      [traktList.id]: [syncedStatus("me/history", 3, undefined, "trakt")],
    },
  });
  const starts = await routeConnectStart(browser);
  await app.open(`/configure?account=${accountId}`);

  await expect(
    screen.getByText(
      "Trakt is not connected, so this list does not show in Stremio.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(screen.getByRole("button", /^Connect again/)).toHaveCount(0);
  await screen
    .getByRole("button", "Connect Trakt for Trakt History", { exact: true })
    .tap();
  await browser.waitForURL(`${backend}/authorize-fixture`);
  expect(starts).toEqual(["POST"]);
});

test("an expired Connection uses one label at every width", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(PHONE);
  await captureConfig(browser, {
    ...configuration,
    lists: [row, traktWatchlist],
    connections: [
      { ...connected("trakt"), needsRenewalSince: "2026-10-02T00:00:00.000Z" },
    ],
  });
  await routeConnectionSources(browser);
  await app.open(`/configure?account=${accountId}`);

  // One in the Providers panel, one in the List's notice.
  await expect(
    screen.getByRole("button", "Connect again", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Connect again for Trakt Watchlist", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByText("Reconnect", { exact: true })).toHaveCount(0);
});

test("the Legacy install ID shows with the lists, not under Providers", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByText(imdbUser, { exact: true })).toBeVisible();
  expect(
    await browser.evaluate(
      (id) =>
        [...document.querySelectorAll("span")]
          .filter((node) => node.textContent === id)
          .every((node) => node.closest("main") !== null),
      imdbUser,
    ),
  ).toBe(true);
});

test("the configure page uses plain words in sentence case", async ({
  app,
  browser,
  screen,
}) => {
  const merged = {
    ...row,
    mergedSources: [{ provider: "trakt" as const, sourceRef: "me/watchlist" }],
  };
  await baseRoutes(browser);
  // Last route wins: a preview with Titles that Stremlist cannot show.
  await browser.route(`${backend}/lists/preview`, (route) => {
    const request = parseBody(route, isPreviewRequest);
    return route.fulfill({
      json: toJson(
        previewOf(request, {
          unresolved: {
            count: 1,
            notCheckedYet: 0,
            entries: [
              { title: "Lost film", year: 1999, type: "movie", url: null },
            ],
          },
        }),
      ),
    });
  });
  await browser.route(`${backend}/${accountId}/config`, (route) =>
    route.fulfill({
      json: toJson({
        ...configuration,
        lists: [merged, { ...traktWatchlist, sourceRef: "me/history" }],
        syncStatus: {},
      }),
    }),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Your lists", { exact: true })).toBeVisible();
  await screen.getByRole("button", `Settings for ${row.catalogTitle}`).tap();
  await screen.getByRole("button", `Preview ${row.catalogTitle}`).tap();
  await expect(screen.getByText("Lost film")).toBeVisible();

  const text = await browser.evaluate(() => document.body.innerText);
  // Internal terms with a capital inside a sentence, and internal names.
  expect(
    text.match(
      /[a-z,] (Lists?|Source lists?|Connections?)\b|Source lists?|Unresolved entries/g,
    ),
  ).toBeNull();
});
