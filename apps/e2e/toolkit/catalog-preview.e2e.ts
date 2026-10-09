import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type {
  CatalogPreviewResponse,
  CatalogPreviewRow,
  PreviewTitle,
} from "@stremlist/shared/catalog-preview";
import type { PreviewRequest } from "./config-fixture";
import {
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  holdToasts,
  fitConfigurePage,
  imdbUser,
  legacyConfiguration,
  parseBody,
  previewOf,
  resolved,
  routeResolve,
  SAVED_REINSTALL,
  toJson,
} from "./config-fixture";

// The Catalog preview of a List (STR-57): what the List adds to Stremio and
// its Unresolved entries, before the user saves. The backend answer is
// intercepted; `tests/catalog-preview.spec.ts` covers the real handler.

const PASTE = "Paste a link to a watchlist or list";
/** The notice of unsaved edits that change the Catalogs of Stremio. */
const NEEDS_REINSTALL = "These changes need a reinstall.";
const LIST_LINK = "https://www.imdb.com/list/ls99887766/";

/**
 * Answer `POST /lists/preview` with `answer(request, index)`; `null` aborts
 * like a network failure. Returns the submitted requests.
 */
async function routePreview(
  browser: Browser,
  answer: (
    request: PreviewRequest,
    index: number,
  ) => CatalogPreviewResponse | null,
) {
  const requests: PreviewRequest[] = [];
  await browser.route(`${backend}/lists/preview`, async (route) => {
    const request = parseBody<PreviewRequest>(route);
    requests.push(request);
    const json = answer(request, requests.length - 1);
    if (json === null) await route.abort();
    else await route.fulfill({ json: toJson(json) });
  });
  return requests;
}

test("a pasted List opens its preview at once, a saved List only on request", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await routeResolve(browser, () => resolved("imdb", "ls99887766", "list"));
  const requests = await routePreview(browser, (request) => previewOf(request));
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  // The saved List keeps its preview closed: nothing is read.
  await expect(
    screen.getByRole("button", "Preview Test catalog"),
  ).toHaveAttribute("aria-expanded", "false");
  expect(requests).toHaveLength(0);

  await screen.getByLabel(PASTE).fill(LIST_LINK);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("IMDb · List · ls99887766")).toBeVisible();
  await expect(screen.getByText("The Shawshank Redemption")).toBeVisible();
  await expect(screen.getByText("The Godfather")).toBeVisible();
  await expect(
    screen.getByRole("link", "The Godfather (1972), on IMDb"),
  ).toHaveAttribute("href", "https://www.imdb.com/title/tt0068646/");
  await expect(
    screen.getByText(
      "This list has no TV shows, so this catalog stays empty in Stremio.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Every entry of this list has an IMDb ID, so Stremio can show them all.",
    ),
  ).toBeVisible();
  expect(requests).toEqual([
    {
      accountKey: accountId,
      provider: "imdb",
      sourceRef: "ls99887766",
      sortOption: "added_at-asc",
      displayMode: "split",
      catalogSettings: {},
    },
  ]);

  // The saved List opens on request, and closes again.
  const toggle = screen.getByRole("button", "Preview Test catalog");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    provider: "imdb",
    sourceRef: imdbUser,
  });
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the preview follows the sort and Show of the List", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  const requests = await routePreview(browser, (request) =>
    previewOf(request, {
      typeCounts: { movie: 2, series: 3 },
      titleCount: 5,
    }),
  );
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(screen.getByText("5 titles")).toBeVisible();
  // Opening a preview changes nothing that Stremio reads at install time.
  await expect(screen.getByText(NEEDS_REINSTALL)).not.toBeVisible();

  await screen.getByRole("combobox", "Sort order").tap();
  await screen.getByRole("option", "IMDb Rating (Highest First)").tap();
  await expect.poll(() => requests.at(-1)?.sortOption).toBe("rating-desc");
  // A sort applies without a reinstall, even though the preview changed.
  await expect(screen.getByText(NEEDS_REINSTALL)).not.toBeVisible();

  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByRole("combobox", "Show", { exact: true }).tap();
  await screen.getByRole("option", "Movies only").tap();
  await expect.poll(() => requests.at(-1)?.displayMode).toBe("movie");
  await expect(
    screen.getByText(
      "3 TV shows of this list do not show, because Show is set to Movies only.",
    ),
  ).toBeVisible();
  await expect(screen.getByRole("heading", /^TV shows/)).not.toBeVisible();
  // Show removes a Catalog, so the save will need a reinstall.
  await expect(screen.getByText(NEEDS_REINSTALL)).toBeVisible();
  // The preview reads; it does not save.
  expect(submissions).toHaveLength(0);
});

test("Unresolved entries are listed, with the ones not checked yet", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  const entries = Array.from({ length: 7 }, (_, index) => ({
    title: `Unmatched entry ${index + 1}`,
    year: 2000 + index,
    type: "movie" as const,
    url:
      index === 0 ? "https://www.justwatch.com/fr/film/unmatched-entry" : null,
  }));
  await routePreview(browser, (request) =>
    previewOf(request, {
      unresolved: { count: 9, notCheckedYet: 2, entries },
    }),
  );
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByRole("heading", /^Unresolved entries/),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Stremlist did not find an IMDb ID for these entries yet, so Stremio does not show them. Stremlist tries again on later refreshes. 2 entries are not checked yet.",
    ),
  ).toBeVisible();
  await expect(screen.getByText("Unmatched entry 5")).toBeVisible();
  await expect(screen.getByText("Unmatched entry 6")).not.toBeVisible();
  await expect(
    screen.getByRole("link", "Open Unmatched entry 1"),
  ).toHaveAttribute(
    "href",
    "https://www.justwatch.com/fr/film/unmatched-entry",
  );

  await screen.getByRole("button", "Show all 7").tap();
  await expect(screen.getByText("Unmatched entry 7")).toBeVisible();
  await expect(screen.getByText("and 2 more")).toBeVisible();
  await screen.getByRole("button", "Show fewer").tap();
  await expect(screen.getByText("Unmatched entry 6")).not.toBeVisible();
});

test("a private Source list explains the problem without a retry", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await routePreview(browser, () => ({ ok: false, reason: "private" }));
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByText(
      "This IMDb watchlist is private. Make your watchlist public in your IMDb account settings.",
    ),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Try again")).not.toBeVisible();
});

test("a failed preview offers Try again and then shows the titles", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  const requests = await routePreview(browser, (request, index) =>
    index === 0 ? null : previewOf(request),
  );
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByText(
      "Could not load the preview. Check your connection and try again.",
    ),
  ).toBeVisible();
  await screen.getByRole("button", "Try again").tap();
  await expect(screen.getByText("The Shawshank Redemption")).toBeVisible();
  await expect(
    screen.getByText(
      "Could not load the preview. Check your connection and try again.",
    ),
  ).not.toBeVisible();
  expect(requests).toHaveLength(2);
});

test("a new setup previews its first List without an Account key", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  await routeResolve(browser, () => resolved("imdb", "ls99887766", "list"));
  // baseRoutes fails the test if the page creates an Account.
  const requests = await routePreview(browser, (request) => previewOf(request));
  await app.open("/configure");
  await screen.getByLabel(PASTE).fill(LIST_LINK);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("The Godfather")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty("accountKey");
});

test("disconnecting the Provider reads the open preview again", async ({
  app,
  browser,
  screen,
}) => {
  const history = {
    ...configuration.lists[0],
    id: "00000000-0000-4000-8000-000000000002",
    provider: "trakt" as const,
    sourceRef: "me/history",
    catalogTitle: "Trakt history",
  };
  const connected = {
    ...configuration,
    lists: [history],
    connections: [
      {
        provider: "trakt" as const,
        username: "fixture-user",
        connectedAt: "2026-10-01T00:00:00.000Z",
        needsRenewalSince: null,
      },
    ],
  };
  await captureConfig(browser, connected);
  let disconnected = false;
  // After the disconnect, the page reads the configuration again.
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    await route.fulfill({
      json: toJson(
        disconnected ? { ...connected, connections: [] } : connected,
      ),
    });
  });
  await browser.route(
    `${backend}/${accountId}/connections/trakt`,
    async (route) => {
      disconnected = true;
      await route.fulfill({ json: { ok: true } });
    },
  );
  await browser.route(
    `${backend}/${accountId}/connections/trakt/sources`,
    async (route) => {
      await route.fulfill({ json: { sources: [] } });
    },
  );
  const requests = await routePreview(browser, (request, index) =>
    index === 0
      ? previewOf(request)
      : { ok: false, reason: "needs_connection" },
  );
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Trakt history").tap();
  await expect(screen.getByText("The Godfather")).toBeVisible();

  await screen.getByRole("button", "Connected to Trakt. Disconnect").tap();
  await screen
    .getByRole("group", "Disconnect Trakt?")
    .getByRole("button", "Disconnect", { exact: true })
    .tap();
  await expect(
    screen.getByText(
      "This list needs your Trakt account. Connect Trakt on the Stremlist configure page.",
    ),
  ).toBeVisible();
  await expect(screen.getByText("The Godfather")).not.toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    accountKey: accountId,
    provider: "trakt",
    sourceRef: "me/history",
  });
});

const LOADING = "Reading the list on IMDb. A big list can take a few seconds.";
const MOVIES = previewOf({ displayMode: "movie" }).catalogs[0].titles;

/**
 * One Catalog row per type of `request` and per preset, like the manifest.
 * `rows` gives the Titles and the total of each `type:preset` row; rows that
 * it does not name are empty.
 */
function catalogsOf(
  request: PreviewRequest,
  rows: Record<string, { total: number; titles: PreviewTitle[] }>,
): CatalogPreviewRow[] {
  const types: CatalogPreviewRow["type"][] =
    request.displayMode === "split"
      ? ["movie", "series"]
      : [request.displayMode];
  const presets = [null, ...(request.catalogSettings?.presets ?? [])];
  return types.flatMap((type) =>
    presets.map((preset) => ({
      type,
      preset,
      ...(rows[`${type}:${preset ?? "main"}`] ?? { total: 0, titles: [] }),
    })),
  );
}

test("the preview shows a loading state, then every Catalog with its empty hints", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  let release = () => {};
  const firstAnswer = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: PreviewRequest[] = [];
  await browser.route(`${backend}/lists/preview`, async (route) => {
    const request = parseBody<PreviewRequest>(route);
    requests.push(request);
    if (requests.length === 1) await firstAnswer;
    // The decade filter leaves no movie; the Top rated Catalog has none.
    const filtered = request.catalogSettings?.decade !== undefined;
    await route.fulfill({
      json: toJson(
        previewOf(request, {
          titleCount: 30,
          typeCounts: { movie: 30, series: 0 },
          catalogs: catalogsOf(request, {
            "movie:main": filtered
              ? { total: 0, titles: [] }
              : { total: 30, titles: MOVIES },
          }),
        }),
      ),
    });
  });
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(screen.getByText(LOADING)).toBeVisible();
  // Nothing shows as ready while the read runs.
  await expect(screen.getByText("The Godfather")).not.toBeVisible();
  release();

  await expect(
    screen.getByRole("heading", /^Movies\s*30 titles$/),
  ).toBeVisible();
  // Twelve Titles at most come back; the rest is a count.
  await expect(screen.getByText("+28")).toBeVisible();
  await expect(
    screen.getByText(
      "This list has no TV shows, so this catalog stays empty in Stremio. Set Show to Movies only in Settings to remove it.",
    ),
  ).toBeVisible();
  await expect(screen.getByText(LOADING)).not.toBeVisible();

  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByRole("button", /^Filters & extra catalogs/).tap();
  await screen.getByRole("checkbox", "Top rated", { exact: true }).tap();
  await expect
    .poll(() => requests.at(-1)?.catalogSettings)
    .toEqual({ presets: ["rated"] });
  await expect(
    screen.getByRole("heading", /^Movies · Top rated\s*0 titles$/),
  ).toBeVisible();
  await expect(
    screen.getByText("This catalog stays empty in Stremio.", { exact: true }),
  ).toBeVisible();

  await screen.getByRole("combobox", "Decade", { exact: true }).tap();
  await screen.getByRole("option", "1990s", { exact: true }).tap();
  await expect
    .poll(() => requests.at(-1)?.catalogSettings)
    .toEqual({ presets: ["rated"], decade: 1990 });
  // The filters apply to the main Catalog and to the Top rated one.
  await expect(
    screen.getByText(
      "No movie of this list matches its filters, so this catalog stays empty in Stremio.",
    ),
  ).toHaveCount(2);
  await expect(screen.getByText("The Godfather")).not.toBeVisible();
  // A settings change keeps the preview on screen: it does not load again.
  await expect(screen.getByText(LOADING)).not.toBeVisible();
  expect(submissions).toHaveLength(0);
});

test("one Unresolved entry and Titles without details are explained", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await routePreview(browser, (request) =>
    previewOf(request, {
      unresolved: {
        count: 1,
        notCheckedYet: 0,
        entries: [{ title: null, year: null, type: "series", url: null }],
      },
      withoutDetails: 1,
    }),
  );
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByRole("heading", /^Unresolved entries\s*1$/),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Stremlist did not find an IMDb ID for this entry yet, so Stremio does not show it. Stremlist tries again on later refreshes.",
    ),
  ).toBeVisible();
  await expect(screen.getByText("Entry without a title")).toBeVisible();
  await expect(screen.getByText("TV show", { exact: true })).toBeVisible();
  await expect(
    screen.getByRole("link", "Open Entry without a title"),
  ).not.toBeVisible();
  await expect(screen.getByRole("button", /^Show all/)).not.toBeVisible();
  await expect(
    screen.getByText(
      "1 title has no details yet, so Stremio does not show it. Stremlist tries again on the next refresh.",
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Every entry of this list has an IMDb ID, so Stremio can show them all.",
    ),
  ).not.toBeVisible();
});

test("a Source list that did not answer offers Try again", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  const requests = await routePreview(browser, (request, index) =>
    index === 0 ? { ok: false, reason: "unavailable" } : previewOf(request),
  );
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(
    screen.getByText("IMDb did not answer. Please try again in a moment."),
  ).toBeVisible();
  await screen.getByRole("button", "Try again").tap();
  await expect(screen.getByText("The Shawshank Redemption")).toBeVisible();
  await expect(
    screen.getByText("IMDb did not answer.", { exact: false }),
  ).not.toBeVisible();
  expect(requests).toHaveLength(2);
});

test("the Legacy alias view previews with the alias as its key", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  const requests = await routePreview(browser, (request) => previewOf(request));
  await app.open(`/configure?account=${imdbUser}`);
  await screen.getByRole("button", "Preview Test catalog").tap();
  await expect(screen.getByText("The Godfather")).toBeVisible();
  expect(requests).toEqual([
    {
      accountKey: imdbUser,
      provider: "imdb",
      sourceRef: imdbUser,
      sortOption: "added_at-asc",
      displayMode: "split",
      catalogSettings: {},
    },
  ]);
});

test(
  "the empty Catalog hint leads the user to the Show setting",
  { tags: ["agent"] },
  async ({ app, agent, browser, screen }) => {
    await holdToasts(browser);
    await fitConfigurePage(browser);
    const submissions = await captureConfig(browser);
    const requests = await routePreview(browser, (request) =>
      previewOf(request),
    );
    await app.open(`/configure?account=${accountId}`);
    await agent.act(
      "Open the preview of Test catalog. Its TV shows catalog stays empty: do what the preview says to remove that catalog, then save.",
      { maxModelCalls: 9 },
    );
    // Removing a Catalog changes what Stremio read at install time.
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    // The reminder stays until the user says they reinstalled.
    await expect(screen.getByRole("button", "I did it")).toBeVisible();
    expect(submissions.at(-1)?.lists[0]).toMatchObject({
      sourceRef: imdbUser,
      displayMode: "movie",
    });
    // The preview asks again 300 ms after the last settings change.
    await expect.poll(() => requests.at(-1)?.displayMode).toBe("movie");
    await expect(screen.getByRole("heading", /^TV shows/)).not.toBeVisible();
  },
);
