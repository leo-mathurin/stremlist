import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type { CatalogPreviewResponse } from "@stremlist/shared/catalog-preview";
import type { AccountConfigInput } from "@stremlist/shared/stremio.types";
import type { PreviewRequest } from "./config-fixture";
import {
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  imdbUser,
  parseBody,
  previewOf,
  resolved,
  routeResolve,
  savedLists,
  toJson,
} from "./config-fixture";

// The Catalog preview of a List (STR-57): what the List adds to Stremio and
// its Unresolved entries, before the user saves. The backend answer is
// intercepted; `tests/catalog-preview.spec.ts` covers the real handler.

const PASTE = "Paste a link to a watchlist or list";
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

  await screen.getByRole("combobox", "Sort order").tap();
  await screen.getByRole("option", "IMDb Rating (Highest First)").tap();
  await expect.poll(() => requests.at(-1)?.sortOption).toBe("rating-desc");

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
  const requests = await routePreview(browser, (request) => previewOf(request));
  const created: AccountConfigInput[] = [];
  await browser.route(`${backend}/accounts`, async (route) => {
    const body = parseBody<AccountConfigInput>(route);
    created.push(body);
    await route.fulfill({
      json: toJson({ ok: true, accountId, lists: savedLists(body) }),
    });
  });
  await app.open("/configure");
  await screen.getByLabel(PASTE).fill(LIST_LINK);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("The Godfather")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty("accountKey");
  expect(created).toHaveLength(0);
});
