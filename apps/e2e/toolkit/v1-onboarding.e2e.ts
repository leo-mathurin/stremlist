import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  accountId,
  backend,
  captureConfig,
  configuration,
  imdbUser,
  legacyConfiguration,
  resolved,
  routeConfig,
  routeCreateAccount,
  routeResolve,
} from "./config-fixture";

// The Stremlist 2.0 card of a v1 install (a Legacy alias) on the configure
// page: what is new, and the optional private Addon URL. Every API answer is
// intercepted.

const TITLE = "Stremlist 2.0 is here. Your install still works.";
const HOME_TITLE = "Found your install. It still works.";
const PASTE = "Paste a link to a watchlist or list";
const LETTERBOXD = "https://letterboxd.com/someone/watchlist/";
const PRIVATE_STEP = /^Get a private Addon URL/;

/** The height of the "Refreshed" line above the Lists. */
function refreshedLineHeight(browser: Browser) {
  return browser.evaluate(() => {
    const status = [...document.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("Refreshed"),
    );
    return status?.parentElement?.getBoundingClientRect().height ?? 0;
  });
}

test("the Stremlist 2.0 card shows on a v1 install only", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await routeConfig(browser, configuration, accountId);

  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByRole("heading", TITLE)).toBeVisible();
  await expect(
    screen.getByText("Your IMDb lists keep syncing. The rest is optional."),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", /^Your IMDb list still syncs/),
  ).toBeVisible();
  await expect(screen.getByText("1 of 3 done")).toBeVisible();
  await expect(
    screen.getByRole("link", "See everything new in 2.0"),
  ).toHaveAttribute("href", "/changelog#v2-0-0");

  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  await expect(screen.getByRole("heading", TITLE)).toHaveCount(0);
  await expect(screen.getByRole("button", /^What's new/)).toHaveCount(0);
});

test("a v1 install opened from Home says that Home found it", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await app.open("/");
  await screen.getByLabel(PASTE).fill(imdbUser);
  await screen.getByRole("button", "Add this list").tap();
  await screen.getByRole("button", "Open my Stremlist").tap();
  await expect(browser).toHaveURL(`/configure?account=${imdbUser}`);
  await expect(screen.getByRole("heading", HOME_TITLE)).toBeVisible();

  // Only the visit from Home: the same page opened again says what is new.
  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByRole("heading", TITLE)).toBeVisible();
  await expect(screen.getByRole("heading", HOME_TITLE)).toHaveCount(0);
});

test("a Letterboxd list added on a v1 install completes the second step", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await routeResolve(browser, (input) =>
    input === LETTERBOXD
      ? resolved("letterboxd", "someone/watchlist", "watchlist")
      : null,
  );
  await app.open(`/configure?account=${imdbUser}`);
  const step = screen.getByRole("button", /^Add a list from another site/);
  await expect(step).toBeExpanded();
  await screen.getByRole("button", "Paste a link").tap();
  const field = screen.getByLabel(PASTE);
  await expect(field).toBeFocused();

  await field.fill(LETTERBOXD);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("2 of 3 done")).toBeVisible();
  await expect(step).toHaveAccessibleName(
    "Add a list from another site (completed)",
  );
  // The next step opens.
  await expect(screen.getByRole("button", PRIVATE_STEP)).toBeExpanded();
  await step.tap();
  await expect(
    screen.getByText("List added. Save, then reinstall to see it."),
  ).toBeVisible();
});

test("the private Addon URL step ends with a link to the new configure page", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  const created = await routeCreateAccount(browser);
  await routeConfig(browser, configuration, accountId);
  await app.open(`/configure?account=${imdbUser}`);

  await screen.getByRole("button", PRIVATE_STEP).tap();
  await expect(
    screen.getByText(
      "Connect Trakt, Simkl or MDBList, and rate or mark as watched from Stremio. Your lists come with you.",
    ),
  ).toBeVisible();
  await screen.getByRole("button", "Create my private Addon URL").tap();

  await expect(screen.getByText("Install your new URL:")).toBeVisible();
  await expect(screen.getByLabel("Addon URL", { exact: true })).toHaveValue(
    `${backend}/${accountId}/manifest.json`,
  );
  await expect(
    screen.getByText(
      "Keep it secret. Then remove the old Stremlist from Stremio.",
    ),
  ).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0].lists).toMatchObject([{ sourceRef: imdbUser }]);

  await screen.getByRole("button", "Done").tap();
  await expect(
    screen.getByText(
      "All set. Open Stremlist from the new install from now on.",
    ),
  ).toBeVisible();
  await expect(screen.getByText("2 of 3 done")).toBeVisible();
  const open = screen.getByRole("link", "Open my new configure page");
  await expect(open).toHaveAttribute("href", `/configure?account=${accountId}`);
  await open.tap();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  await expect(
    screen.getByRole("heading", "Your Stremlist is ready"),
  ).toBeVisible();
  expect(created).toHaveLength(1);
});

test("a closed Stremlist 2.0 card stays closed until What's new opens it", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await app.open(`/configure?account=${imdbUser}`);
  await screen.getByRole("button", "Hide what's new").tap();
  await expect(screen.getByRole("heading", TITLE)).toHaveCount(0);

  // This browser remembers it for this install.
  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  await expect(screen.getByRole("heading", TITLE)).toHaveCount(0);
  await screen.getByRole("button", "What's new in 2.0").tap();
  await expect(screen.getByRole("heading", TITLE)).toBeVisible();
  await expect(screen.getByRole("button", /^What's new/)).toHaveCount(0);

  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByRole("heading", TITLE)).toBeVisible();
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width} px, What's new keeps the height of the Refreshed line`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport(viewport);
    await captureConfig(browser, legacyConfiguration, imdbUser);
    await app.open(`/configure?account=${imdbUser}`);
    await expect(screen.getByRole("heading", TITLE)).toBeVisible();
    const before = await refreshedLineHeight(browser);

    await screen.getByRole("button", "Hide what's new").tap();
    await expect(screen.getByRole("button", /^What's new/)).toBeVisible();
    expect(await refreshedLineHeight(browser)).toBe(before);
    expect(before).toBe(36);
  });
}
