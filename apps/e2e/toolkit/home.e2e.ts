import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  imdbUser,
} from "./config-fixture";

// The redesigned Home, Terms and Changelog pages: deterministic checks of
// their sections, links and states. Every API answer is intercepted.

const ADDON_URL_HELP =
  "Paste the Addon URL that you installed in Stremio. It ends with /manifest.json.";

test("Home shows every Provider, the live count and the help sections", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  for (const heading of [
    "Many sites, one addon",
    "Paste a link",
    "Connect an account",
    "Every List is a row in Stremio",
    "How it works",
    "Features",
    "Where to find your Lists",
    "Troubleshooting",
  ]) {
    await expect(screen.getByRole("heading", heading)).toBeVisible();
  }

  // The Providers diagram: one row per Provider, Letterboxd marked as soon.
  const diagram = screen.getByRole("region", "Many sites, one addon");
  await expect(diagram.getByRole("listitem")).toHaveText([
    "IMDb",
    "Trakt",
    "Simkl",
    "MDBList",
    "JustWatch",
    "SensCritique",
    "Letterboxd Soon",
  ]);

  // `/stats` answers 2 active Accounts in the fixture.
  await expect(screen.getByText("people use Stremlist")).toBeVisible();
  await expect(screen.getByText("2 people use Stremlist")).toBeAttached();

  await expect(
    screen.getByRole("link", "Stremio Addon Manager"),
  ).toHaveAttribute("href", "https://stremio-addon-manager.vercel.app/");

  // Troubleshooting: each problem opens and closes its fix. A closed fix
  // keeps its text in the page, but its panel is inert.
  const problem = screen.getByRole("button", "I lost my configure page");
  const panelId = await problem.getAttribute("aria-controls");
  const panel = browser.locator(`[id="${panelId}"]`);
  await expect(problem).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveAttribute("inert", "");
  await problem.tap();
  await expect(problem).toHaveAttribute("aria-expanded", "true");
  await expect(panel).not.toHaveAttribute("inert", "");
  await expect(
    screen.getByText(
      "Open it from the Stremlist addon in Stremio, or paste your Addon URL above.",
    ),
  ).toBeVisible();
  await problem.tap();
  await expect(problem).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveAttribute("inert", "");

  await screen.getByRole("link", "terms and privacy policy").tap();
  await expect(browser).toHaveURL("/terms");
  await expect(screen.getByRole("heading", "Terms and privacy")).toBeVisible();
});

type StatsReads = { statsStarted?: number; statsRead?: number };

/**
 * Counts the `/stats` requests that the page starts and the answers that it
 * has read. An answer counts one task after `response.json()` settles, so the
 * app's own `.then` (which hands the number to React) has already run.
 */
async function countStatsReads(browser: Browser) {
  await browser.addInitScript(() => {
    const scope = window as unknown as StatsReads;
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, location.href).pathname !== "/stats")
        return fetch(input, init);
      scope.statsStarted = (scope.statsStarted ?? 0) + 1;
      const response = await fetch(input, init);
      const read = response.json.bind(response);
      response.json = () => {
        const body = read() as Promise<unknown>;
        const done = () =>
          setTimeout(() => {
            scope.statsRead = (scope.statsRead ?? 0) + 1;
          }, 0);
        body.then(done, done);
        return body;
      };
      return response;
    };
  });
}

/**
 * Waits until the page has read every `/stats` answer and rendered it.
 * StrictMode mounts Home twice in development, so there can be two.
 */
async function statsRendered(browser: Browser) {
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const { statsStarted = 0, statsRead = 0 } =
          window as unknown as StatsReads;
        return statsStarted > 0 && statsRead === statsStarted;
      }),
    )
    .toBe(true);
  // React renders the new count in a task queued before this one.
  await browser.evaluate(
    () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
  );
}

test("the live count reads one person and hides when stats fail", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  await countStatsReads(browser);
  let stats: "one" | "zero" | "error" = "one";
  await browser.route(`${backend}/stats`, async (route) => {
    if (stats === "error")
      await route.fulfill({ status: 500, json: { error: "Fixture failure" } });
    else
      await route.fulfill({
        json: { activeUsers: stats === "one" ? 1 : 0 },
      });
  });
  // The sr-only sentence and the visible label under the digits.
  const liveCount = screen.getByText(/(person uses|people use) Stremlist$/);

  // The count starts hidden, so a check made before `/stats` answers would
  // pass on the initial state. Each check waits for the answer to render.
  for (const state of ["one", "zero", "error"] as const) {
    stats = state;
    await app.open("/");
    await statsRendered(browser);
    if (state === "one") {
      await expect(liveCount).toHaveCount(2);
      await expect(screen.getByText("1 person uses Stremlist")).toBeAttached();
      await expect(screen.getByText("person uses Stremlist")).toBeVisible();
    } else {
      await expect(liveCount).toHaveCount(0);
    }
  }
});

test("Open it refuses text that is not an Addon URL, then opens one", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await app.open("/");
  await screen.getByRole("button", "Open it").tap();
  const field = screen.getByLabel("Your Addon URL");
  await field.fill(`https://www.imdb.com/user/${imdbUser}/watchlist`);
  await screen.getByRole("button", "Open", { exact: true }).tap();
  await expect(screen.getByRole("alert")).toHaveText(ADDON_URL_HELP);
  await expect(browser).toHaveURL("/");
  // Typing again removes the error.
  await field.fill(`stremio://127.0.0.1:4314/${accountId}/manifest.json`);
  await expect(screen.getByText(ADDON_URL_HELP)).toBeHidden();
  await screen.getByRole("button", "Open", { exact: true }).tap();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
});

test("Terms and Changelog link their sections and lead back Home", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/terms");
  const terms = screen.getByRole("navigation", "On this page");
  await expect(terms.getByRole("link")).toHaveText([
    "Terms and Conditions",
    "Privacy Policy",
  ]);
  await terms.getByRole("link", "Privacy Policy").tap();
  await expect(browser).toHaveURL("/terms#privacy");
  await expect(screen.getByRole("heading", "Privacy Policy")).toBeVisible();
  await screen
    .getByRole("navigation", "Site")
    .getByRole("link", "Changelog")
    .tap();
  await expect(browser).toHaveURL("/changelog");

  const versions = screen.getByRole("navigation", "On this page");
  await expect(versions.getByRole("link").first()).toHaveText(
    "v1.10.0 September 15, 2026",
  );
  await versions.getByRole("link", /^v1\.0\.0/).tap();
  await expect(browser).toHaveURL("/changelog#v1-0-0");
  await expect(screen.getByRole("heading", "v1.0.0")).toBeVisible();
  await expect(
    screen
      .getByRole("listitem")
      .filter({ hasText: "Initial release of Stremlist" }),
  ).toHaveText("EnhancementInitial release of Stremlist");

  await screen.getByRole("link", "Back to Home").tap();
  await expect(browser).toHaveURL("/");
  await expect(
    screen.getByRole("heading", "Your lists, all in Stremio."),
  ).toBeVisible();
});

test("the Home field starts an empty setup or opens a pasted Addon URL", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  await app.open("/");
  await screen.getByRole("button", "Build my Stremlist").tap();
  await expect(browser).toHaveURL("/configure");
  await expect(screen.getByText("No Lists yet")).toBeVisible();
  await expect(
    screen.getByRole("button", "Save and get my Addon URL"),
  ).toBeDisabled();

  await app.open("/");
  await screen
    .getByLabel("Paste a link to a watchlist or list")
    .fill(`${backend}/${accountId}/manifest.json`);
  await expect(screen.getByText("Addon URL detected")).toBeVisible();
  await screen.getByRole("button", "Add this list").tap();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
});
