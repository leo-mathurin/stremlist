import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Screen } from "e2e";
import type {
  AccountConfigInput,
  AccountConfigResponse,
  ConfigList,
} from "@stremlist/shared/stremio.types";
import {
  SAVED_REINSTALL,
  accountId,
  captureConfig,
  configuration,
  imdbUser,
  resolved,
  routeResolve,
  row,
} from "./config-fixture";

// Merged Lists (STR-59, ADR 0006): one List, several Source lists, one
// Catalog. The intercepted API proves UI state and the exact save payload;
// tests/merged-lists.spec.ts covers storage and the served Catalog.

const PASTE = "Paste a link to a watchlist or list";
const MERGE = "Merge another List into this one";
// Closed settings panels stay in the DOM, so every List has a merge menu
// button; the first one is always the first List's.
const NO_DATES =
  "Date added sorting is off: Top 250 Movies does not give the date when each Title was added.";
const ONE_TYPE = 'Top 250 Movies has only movies, so "TV shows only" is off.';

const watchlist = {
  ...row,
  catalogTitle: "IMDb Watchlist",
  sortOption: "added_at-desc",
} satisfies ConfigList;
const favourites = {
  ...row,
  id: "00000000-0000-4000-8000-000000000002",
  sourceRef: "ls99123456",
  catalogTitle: "Favourite films",
  sortOption: "rating-desc",
  position: 1,
} satisfies ConfigList;
const top250 = {
  ...row,
  id: "00000000-0000-4000-8000-000000000003",
  sourceRef: "imdb:top-rated-movies",
  catalogTitle: "Top 250 Movies",
  displayMode: "movie",
  position: 2,
} satisfies ConfigList;
const trending = {
  ...row,
  id: "00000000-0000-4000-8000-000000000004",
  provider: "trakt",
  sourceRef: "trending",
  catalogTitle: "Trakt Trending",
  position: 3,
} satisfies ConfigList;

function withLists(lists: ConfigList[]): AccountConfigResponse {
  return { ...configuration, lists };
}

/** The Lists of a save as the fields that the merge changes. */
function sources(submitted: AccountConfigInput) {
  return submitted.lists.map((list) => ({
    id: list.id,
    provider: list.provider,
    sourceRef: list.sourceRef,
    catalogTitle: list.catalogTitle,
    sortOption: list.sortOption,
    displayMode: list.displayMode,
    position: list.position,
    mergedSources: list.mergedSources,
  }));
}

async function openSettings(screen: Screen, title: string) {
  await screen.getByRole("button", `Settings for ${title}`).tap();
}

test(
  "merging a List into another shows one catalog and saves its Source lists",
  { tags: ["agent", "merged-lists"] },
  async ({ app, agent, screen, browser }) => {
    const submissions = await captureConfig(
      browser,
      withLists([watchlist, favourites, top250, trending]),
    );
    await app.open(`/configure?account=${accountId}`);
    await expect(screen.getByText("Favourite films")).toBeVisible();
    await agent.act(
      "Show the List Favourite films in the same Stremio catalog as the List IMDb Watchlist, then save.",
      { maxModelCalls: 8 },
    );
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    await expect(screen.getByText("2 Source lists · IMDb")).toBeVisible();
    await expect(screen.getByText(/^3 of 10 lists/)).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(sources(submissions[0])).toEqual([
      {
        id: watchlist.id,
        provider: "imdb",
        sourceRef: imdbUser,
        catalogTitle: "IMDb Watchlist",
        sortOption: "added_at-desc",
        displayMode: "split",
        position: 0,
        // The merged List's title names its Source list.
        mergedSources: [
          {
            provider: "imdb",
            sourceRef: "ls99123456",
            label: "Favourite films",
          },
        ],
      },
      {
        id: top250.id,
        provider: "imdb",
        sourceRef: "imdb:top-rated-movies",
        catalogTitle: "Top 250 Movies",
        sortOption: "added_at-asc",
        displayMode: "movie",
        position: 1,
        mergedSources: [],
      },
      {
        id: trending.id,
        provider: "trakt",
        sourceRef: "trending",
        catalogTitle: "Trakt Trending",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 2,
        mergedSources: [],
      },
    ]);
  },
);

test("merging a chart turns off Date added and TV shows only, with the reasons", async ({
  app,
  screen,
  browser,
}) => {
  const submissions = await captureConfig(
    browser,
    withLists([watchlist, top250]),
  );
  await app.open(`/configure?account=${accountId}`);
  await openSettings(screen, "IMDb Watchlist");
  await expect(screen.getByText(NO_DATES)).toBeHidden();

  // Keyboard only: open the menu, take the first List, and keep focus.
  const merge = screen.getByRole("button", MERGE).first();
  await merge.press("Enter");
  await expect(screen.getByRole("menuitem", "Top 250 Movies")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("2 Source lists · IMDb")).toBeVisible();
  await expect(screen.getByRole("button", MERGE).first()).toBeFocused();

  await expect(screen.getByText(NO_DATES)).toBeVisible();
  await expect(screen.getByText(ONE_TYPE)).toBeVisible();
  // The date sort of the List falls back to an allowed one.
  await expect(screen.getByLabel("Sort order").first()).toHaveText(
    "Title (A-Z)",
  );
  await screen.getByLabel("Sort order").first().tap();
  await expect(
    screen.getByRole("option", "Date Added (Newest First)"),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    screen.getByRole("option", "Date Added (Oldest First)"),
  ).toHaveAttribute("aria-disabled", "true");
  await browser.keyboard.press("Escape");
  await screen.getByLabel("Show", { exact: true }).tap();
  await expect(screen.getByRole("option", "TV shows only")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(screen.getByRole("option", "Movies only")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await browser.keyboard.press("Escape");

  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(sources(submissions[0])).toEqual([
    {
      id: watchlist.id,
      provider: "imdb",
      sourceRef: imdbUser,
      catalogTitle: "IMDb Watchlist",
      sortOption: "title-asc",
      displayMode: "split",
      position: 0,
      mergedSources: [
        {
          provider: "imdb",
          sourceRef: "imdb:top-rated-movies",
          label: "Top 250 Movies",
        },
      ],
    },
  ]);
});

test("a Source list moves to its own List or leaves the merged List", async ({
  app,
  screen,
  browser,
}) => {
  const merged = {
    ...watchlist,
    mergedSources: [
      { provider: "imdb", sourceRef: "ls99123456", label: "Favourite films" },
      {
        provider: "trakt",
        sourceRef: "users/sean/watchlist",
        label: "Sean picks",
      },
    ],
  } satisfies ConfigList;
  const submissions = await captureConfig(
    browser,
    withLists([merged, { ...trending, position: 1 }]),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("3 Source lists · IMDb, Trakt")).toBeVisible();
  await openSettings(screen, "IMDb Watchlist");
  await expect(screen.getByText("3 of 5")).toBeVisible();

  await screen
    .getByRole("button", "Move Favourite films to its own List")
    .tap();
  // The new List comes just below, with the title it had before the merge.
  await expect(
    screen.getByRole("button", "Settings for Favourite films"),
  ).toBeVisible();
  await expect(screen.getByRole("button", MERGE).first()).toBeFocused();
  await screen.getByRole("button", "Remove Sean picks from this List").tap();
  await expect(screen.getByText("1 of 5")).toBeVisible();
  await expect(screen.getByText(/^IMDb · Watchlist/).first()).toBeVisible();

  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(sources(submissions[0])).toEqual([
    {
      id: watchlist.id,
      provider: "imdb",
      sourceRef: imdbUser,
      catalogTitle: "IMDb Watchlist",
      sortOption: "added_at-desc",
      displayMode: "split",
      position: 0,
      mergedSources: [],
    },
    {
      id: undefined,
      provider: "imdb",
      sourceRef: "ls99123456",
      catalogTitle: "Favourite films",
      sortOption: "added_at-asc",
      displayMode: "split",
      position: 1,
      mergedSources: [],
    },
    {
      id: trending.id,
      provider: "trakt",
      sourceRef: "trending",
      catalogTitle: "Trakt Trending",
      sortOption: "added_at-asc",
      displayMode: "split",
      position: 2,
      mergedSources: [],
    },
  ]);
});

test("a List merges at most five Source lists", async ({
  app,
  screen,
  browser,
}) => {
  const four = {
    ...watchlist,
    mergedSources: ["ls1", "ls2", "ls3"].map((sourceRef) => ({
      provider: "imdb" as const,
      sourceRef,
    })),
  } satisfies ConfigList;
  const two = {
    ...favourites,
    mergedSources: [{ provider: "imdb", sourceRef: "ls4" }],
  } satisfies ConfigList;
  await captureConfig(
    browser,
    withLists([four, two, { ...trending, position: 2 }]),
  );
  await app.open(`/configure?account=${accountId}`);
  await openSettings(screen, "IMDb Watchlist");
  await expect(screen.getByText("4 of 5")).toBeVisible();
  await screen.getByRole("button", MERGE).first().tap();
  // Favourite films has two Source lists: one more than there is room for.
  await expect(screen.getByRole("menuitem", /^Favourite films/)).toBeDisabled();
  await screen.getByRole("menuitem", "Trakt Trending").tap();
  await expect(screen.getByText("5 of 5")).toBeVisible();
  await expect(
    screen.getByRole("button", "At most 5 Source lists"),
  ).toBeDisabled();
});

test("a Source list that is in a merged List cannot be added again", async ({
  app,
  screen,
  browser,
}) => {
  const merged = {
    ...watchlist,
    mergedSources: [{ provider: "imdb", sourceRef: "ls99123456" }],
  } satisfies ConfigList;
  await captureConfig(browser, withLists([merged]));
  const inputs = await routeResolve(browser, () =>
    resolved("imdb", "ls99123456", "list"),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("2 Source lists · IMDb")).toBeVisible();
  await screen.getByLabel(PASTE).fill("https://www.imdb.com/list/ls99123456/");
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(
    screen.getByText("This list is already in your Stremlist."),
  ).toBeVisible();
  await expect(screen.getByText(/^1 of 10 lists/)).toBeVisible();
  expect(inputs).toHaveLength(1);
});
