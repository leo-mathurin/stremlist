import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { QueuedAnswer } from "@stremlist/shared/provider-queue";
import type { AccountSyncSnapshot } from "@stremlist/shared/stremio.types";
import {
  accountId,
  backend,
  captureConfig,
  configuration,
  parseBody,
  previewOf,
  resolved,
  routePreview,
  row,
  toJson,
} from "./config-fixture";

// The queue state of a busy Letterboxd: the link check, the Catalog preview
// and the sync line of a saved List show the estimated wait. The backend
// answers are intercepted; the backend tests cover the queue itself.

const PASTE = "Paste a link to a watchlist or list";
const LINK = "https://letterboxd.com/someone/watchlist/";
const TICKET = "6bde5e3d-617f-4912-950a-2f9acf815b7e";

function queued(waitMs: number, retryMs: number): QueuedAnswer {
  return {
    ok: false,
    reason: "queued",
    provider: "letterboxd",
    waitMs,
    retryMs,
    ticket: TICKET,
  };
}

test("a busy Letterboxd shows the wait on the link check and the preview, then the List", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  const checks: { input: string; ticket?: string }[] = [];
  await browser.route(`${backend}/links/resolve`, async (route) => {
    checks.push(parseBody(route));
    await route.fulfill({
      json: toJson(
        checks.length < 3
          ? queued(12_000, 1_500)
          : resolved("letterboxd", "users/someone/watchlist", "watchlist", {
              suggestedTitle: "Someone's watchlist",
            }),
      ),
    });
  });
  const previews = await routePreview(browser, (request, index) =>
    index < 2 ? queued(40_000, 1_500) : previewOf(request, { titleCount: 2 }),
  );
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();

  await screen.getByLabel(PASTE).fill(LINK);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(
    screen.getByRole("button", /^In the Letterboxd queue · about 1[0-2] s$/),
  ).toBeVisible();
  await app.screenshot("Letterboxd queue on the link check");

  // The preview of the new List waits in the queue with a bar.
  await expect(
    screen.getByText(
      /^Letterboxd is busy right now\. Your list is in the queue, about (39|40) s left\.$/,
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    screen.getByRole("progressbar", "Place in the queue"),
  ).toBeVisible();
  // Let the bar fill a little for the screenshot.
  await new Promise((done) => setTimeout(done, 2_000));
  await app.screenshot("Letterboxd queue on the Catalog preview");
  await expect(screen.getByText("The Shawshank Redemption")).toBeVisible({
    timeout: 10_000,
  });
  await expect(screen.getByRole("progressbar")).not.toBeVisible();

  // Each check asks again with the ticket, to keep its place in the queue.
  expect(checks.map((check) => check.ticket)).toEqual([
    undefined,
    TICKET,
    TICKET,
  ]);
  expect(previews.map((preview) => preview.ticket)).toEqual([
    undefined,
    TICKET,
    TICKET,
  ]);
});

test("a saved List that waits for a busy Letterboxd shows the wait on its sync line", async ({
  app,
  browser,
  screen,
}) => {
  const waiting = {
    ...row,
    id: "00000000-0000-4000-8000-000000000301",
    provider: "letterboxd" as const,
    sourceRef: "users/someone/watchlist",
    catalogTitle: "Someone's watchlist",
    position: 1,
  };
  const readQueue = {
    [waiting.id]: {
      provider: "letterboxd" as const,
      readyAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    },
  };
  await captureConfig(browser, {
    ...configuration,
    lists: [row, waiting],
    readQueue,
  });
  await browser.route(`${backend}/${accountId}/sync-status`, async (route) => {
    const answer: AccountSyncSnapshot = {
      syncStatus: configuration.syncStatus,
      connections: [],
      readQueue,
    };
    await route.fulfill({ json: toJson(answer) });
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(
    screen.getByText("In the Letterboxd queue · about 2 min", { exact: true }),
  ).toBeVisible();
  await app.screenshot("Letterboxd queue on the sync line");
});
