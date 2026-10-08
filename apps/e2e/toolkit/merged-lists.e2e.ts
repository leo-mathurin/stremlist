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
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  imdbUser,
  parseBody,
  resolved,
  routeResolve,
  row,
  savedLists,
  toJson,
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
const SOURCE_LIMIT = "You can have at most 20 Source lists in all your Lists.";
const CHANGED_ELSEWHERE =
  "Your Lists changed in another window. Reload the page and try again.";

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
      "In the settings of the List IMDb Watchlist, merge the List Favourite films into it, so both show in one catalog. Then save.",
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
  // Trakt Trending stays, so the merge menu is still there after the merge.
  const submissions = await captureConfig(
    browser,
    withLists([watchlist, top250, { ...trending, position: 2 }]),
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
  await screen.getByLabel("Show", { exact: true }).first().tap();
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
    {
      id: trending.id,
      provider: "trakt",
      sourceRef: "trending",
      catalogTitle: "Trakt Trending",
      sortOption: "added_at-asc",
      displayMode: "split",
      position: 1,
      mergedSources: [],
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
  await expect(screen.getByText("1 of 5").first()).toBeVisible();
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

test("a merged Source list keeps its name when it moves to the first place", async ({
  app,
  screen,
  browser,
}) => {
  const merged = {
    ...watchlist,
    mergedSources: [
      {
        provider: "imdb",
        sourceRef: "ls99123456",
        label: "Family picks",
      },
      {
        provider: "trakt",
        sourceRef: "users/sean/watchlist",
        label: "Sean picks",
      },
    ],
  } satisfies ConfigList;
  const submissions = await captureConfig(browser, withLists([merged]));
  await app.open(`/configure?account=${accountId}`);
  await openSettings(screen, "IMDb Watchlist");
  await screen
    .getByRole("button", "Remove IMDb Watchlist from this List")
    .tap();
  await expect(
    screen.getByRole("button", "Move Family picks to its own List"),
  ).toBeVisible();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions[0].lists).toMatchObject([
    {
      provider: "imdb",
      sourceRef: "ls99123456",
      sourceLabel: "Family picks",
      mergedSources: [
        {
          provider: "trakt",
          sourceRef: "users/sean/watchlist",
          label: "Sean picks",
        },
      ],
    },
  ]);

  // The first Source list moves to its own List with its own name.
  await screen.getByRole("button", "Move Family picks to its own List").tap();
  await expect(
    screen.getByRole("button", "Settings for Family picks"),
  ).toBeVisible();
});

test("merging the last other List moves focus to the Source lists", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(browser, withLists([watchlist, favourites]));
  await app.open(`/configure?account=${accountId}`);
  await openSettings(screen, "IMDb Watchlist");
  await screen.getByRole("button", MERGE).first().press("Enter");
  await expect(screen.getByRole("menuitem", "Favourite films")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("2 Source lists · IMDb")).toBeVisible();
  await expect(screen.getByText("Source lists", { exact: true })).toBeFocused();
});

test("an Account with 20 Source lists refuses one more, from Quick add or a link", async ({
  app,
  screen,
  browser,
}) => {
  // Four Lists of five Source lists: the Account limit, with room for Lists.
  const groups = [1, 2, 3, 4].map(
    (group) =>
      ({
        ...row,
        id: `00000000-0000-4000-8000-00000000002${group}`,
        sourceRef: `ls99${group}00000`,
        catalogTitle: `Group ${group}`,
        sortOption: "title-asc",
        position: group - 1,
        mergedSources: [1, 2, 3, 4].map((n) => ({
          provider: "imdb" as const,
          sourceRef: `ls99${group}0000${n}`,
        })),
      }) satisfies ConfigList,
  );
  const submissions = await captureConfig(browser, withLists(groups));
  const inputs = await routeResolve(browser, () =>
    resolved("imdb", "ls99123456", "list"),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText(/^4 of 10 lists/)).toBeVisible();

  await screen.getByRole("button", "Add an IMDb chart").tap();
  await screen.getByRole("menuitem", /^Top 250 Movies/).tap();
  await expect(screen.getByText(SOURCE_LIMIT)).toBeVisible();
  await expect(screen.getByText(/^4 of 10 lists/)).toBeVisible();

  // A Trakt chart is refused the same way: the message stays, no List.
  await screen.getByRole("button", "Trending").tap();
  await expect(screen.getByText(SOURCE_LIMIT)).toHaveCount(1);
  await expect(screen.getByText(/^4 of 10 lists/)).toBeVisible();

  await screen.getByLabel(PASTE).fill("https://www.imdb.com/list/ls99123456/");
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText(SOURCE_LIMIT)).toHaveCount(2);
  await expect(screen.getByText(/^4 of 10 lists/)).toBeVisible();
  expect(inputs).toHaveLength(1);
  expect(submissions).toHaveLength(0);
});

test("a Source list cannot move to its own List when the Account has 10 Lists", async ({
  app,
  screen,
  browser,
}) => {
  const merged = {
    ...watchlist,
    mergedSources: [
      { provider: "imdb", sourceRef: "ls99123456", label: "Favourite films" },
    ],
  } satisfies ConfigList;
  const others = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
    (n) =>
      ({
        ...row,
        id: `00000000-0000-4000-8000-00000000003${n}`,
        sourceRef: `ls9930000${n}`,
        catalogTitle: `Other ${n}`,
        position: n,
      }) satisfies ConfigList,
  );
  const submissions = await captureConfig(
    browser,
    withLists([merged, ...others]),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText(/^10 of 10 lists/)).toBeVisible();
  await openSettings(screen, "IMDb Watchlist");
  const move = screen.getByRole(
    "button",
    "Move Favourite films to its own List",
  );
  await expect(move).toBeDisabled();
  await expect(move).toHaveAttribute(
    "title",
    "You have the maximum number of lists",
  );
  // Removing a Source list stays possible.
  await expect(
    screen.getByRole("button", "Remove Favourite films from this List"),
  ).toBeEnabled();

  // With room for one more List, the Source list can move.
  await screen.getByRole("button", "Remove Other 9", { exact: true }).tap();
  await expect(screen.getByText(/^9 of 10 lists/)).toBeVisible();
  await expect(move).toBeEnabled();
  await move.tap();
  await expect(
    screen.getByRole("button", "Settings for Favourite films"),
  ).toBeVisible();
  await expect(screen.getByText(/^10 of 10 lists/)).toBeVisible();
  expect(submissions).toHaveLength(0);
});

test("a movie chart and a TV chart in one List show both, with the reasons", async ({
  app,
  screen,
  browser,
}) => {
  const top250tv = {
    ...row,
    id: "00000000-0000-4000-8000-000000000005",
    sourceRef: "imdb:top-rated-tv",
    catalogTitle: "Top 250 TV Shows",
    displayMode: "series",
    position: 1,
  } satisfies ConfigList;
  const submissions = await captureConfig(
    browser,
    withLists([
      { ...top250, position: 0 },
      top250tv,
      { ...trending, position: 2 },
    ]),
  );
  await app.open(`/configure?account=${accountId}`);
  await openSettings(screen, "Top 250 Movies");
  await screen.getByRole("button", MERGE).first().tap();
  await screen.getByRole("menuitem", "Top 250 TV Shows").tap();
  await expect(screen.getByText("2 Source lists · IMDb")).toBeVisible();

  await expect(
    screen.getByText(
      "Top 250 Movies has only movies and Top 250 TV Shows has only TV shows, so this List shows both.",
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Date added sorting is off: Top 250 Movies and Top 250 TV Shows do not give the date when each Title was added.",
    ),
  ).toBeVisible();
  // "Movies only" falls back to both Title types; neither single type is left.
  const show = screen.getByLabel("Show", { exact: true }).first();
  await expect(show).toHaveText("Movies & TV shows");
  await show.tap();
  for (const option of ["Movies only", "TV shows only"]) {
    await expect(screen.getByRole("option", option)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }
  await screen.getByRole("option", "Movies & TV shows").tap();

  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(sources(submissions[0])[0]).toEqual({
    id: top250.id,
    provider: "imdb",
    sourceRef: "imdb:top-rated-movies",
    catalogTitle: "Top 250 Movies",
    sortOption: "title-asc",
    displayMode: "split",
    position: 0,
    mergedSources: [
      {
        provider: "imdb",
        sourceRef: "imdb:top-rated-tv",
        label: "Top 250 TV Shows",
      },
    ],
  });
});

test("a merged Source list without its Connection says so and offers to connect", async ({
  app,
  screen,
  browser,
}) => {
  const merged = {
    ...watchlist,
    sortOption: "title-asc",
    mergedSources: [
      { provider: "trakt", sourceRef: "me/watchlist", label: "My Trakt picks" },
    ],
  } satisfies ConfigList;
  await captureConfig(browser, withLists([merged]));
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("2 Source lists · IMDb, Trakt")).toBeVisible();
  await expect(
    screen.getByText(
      "Trakt is not connected, so its Source list does not show in this catalog.",
    ),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Connect again", { exact: true }),
  ).toBeVisible();
  await openSettings(screen, "IMDb Watchlist");
  // Only the Trakt Source list has the badge.
  await expect(screen.getByText("Not connected", { exact: true })).toHaveCount(
    1,
  );

  // Without the Trakt Source list, the List needs no Connection.
  await screen
    .getByRole("button", "Remove My Trakt picks from this List")
    .tap();
  await expect(
    screen.getByText(
      "Trakt is not connected, so its Source list does not show in this catalog.",
    ),
  ).toBeHidden();
  await expect(screen.getByText("Not connected", { exact: true })).toHaveCount(
    0,
  );
});

test("a save refused because the Lists changed in another window keeps the merge", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({
        json: toJson(withLists([watchlist, favourites, top250])),
      });
      return;
    }
    const submitted = parseBody<AccountConfigInput>(route);
    submissions.push(submitted);
    await route.fulfill(
      submissions.length === 1
        ? { status: 409, json: { error: CHANGED_ELSEWHERE } }
        : { json: toJson({ ok: true, lists: savedLists(submitted) }) },
    );
  });
  await app.open(`/configure?account=${accountId}`);
  await openSettings(screen, "IMDb Watchlist");
  await screen.getByRole("button", MERGE).first().tap();
  await screen.getByRole("menuitem", "Favourite films").tap();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(CHANGED_ELSEWHERE)).toBeVisible();
  await expect(screen.getByText("2 Source lists · IMDb")).toBeVisible();

  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1].lists[0].mergedSources).toEqual([
    { provider: "imdb", sourceRef: "ls99123456", label: "Favourite films" },
  ]);
});
