import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  imdbUser,
  legacyConfiguration,
  resolved,
  routeConfig,
  routeCreateAccount,
  routeResolve,
  saveButton,
} from "./config-fixture";

// The security rules of Connect and of the Legacy alias upgrade, from the
// configure page. The API is intercepted: tests/provider-*.spec.ts and
// tests/addon-api.spec.ts run the real backend.

const PASTE = "Paste a link to a watchlist or list";

test("a cancelled connect of a new setup creates no Account", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const created = await routeCreateAccount(browser);
  const starts: string[] = [];
  await browser.route(`${backend}/connections/simkl/start`, async (route) => {
    starts.push(route.request.method);
    await route.fulfill({
      json: {
        ok: true,
        authorizeUrl: "https://simkl.com/oauth/authorize?state=fixture-state",
        browserKey: "fixture-browser-key",
      },
    });
  });
  // The user cancels on Simkl, which sends the browser back through the
  // backend callback.
  await browser.route("https://simkl.com/oauth/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>location.replace("http://127.0.0.1:4311/configure#oauth=simkl&state=fixture-state&oauth_error=denied")</script>`,
    });
  });

  await app.open("/configure");
  await screen
    .getByRole("listitem")
    .filter({ hasText: "Simkl" })
    .getByRole("button", "Connect")
    .tap();

  await expect(
    screen.getByText("You cancelled the connection to Simkl. Nothing changed."),
  ).toBeVisible();
  await expect(browser).toHaveURL("/configure");
  expect(starts).toEqual(["POST"]);
  // Nothing installable was made for the cancelled connect.
  expect(created).toEqual([]);
});

test("a new setup gets its Account with the Connection, and keeps its Lists", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const created = await routeCreateAccount(browser);
  await routeConfig(browser, {
    ...configuration,
    connections: [
      {
        provider: "simkl",
        username: "someone",
        connectedAt: "2026-10-01T00:00:00.000Z",
        needsRenewalSince: null,
      },
    ],
  });
  await browser.route(`${backend}/connections/simkl/start`, async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        authorizeUrl: "https://simkl.com/oauth/authorize?state=fixture-state",
        browserKey: "fixture-browser-key",
      },
    });
  });
  await browser.route("https://simkl.com/oauth/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>location.replace("http://127.0.0.1:4311/configure#oauth=simkl&state=fixture-state&code=fixture-code")</script>`,
    });
  });
  const completions: Record<string, unknown>[] = [];
  await browser.route(
    `${backend}/connections/simkl/complete`,
    async (route) => {
      completions.push(
        JSON.parse(route.request.postData ?? "{}") as Record<string, unknown>,
      );
      await route.fulfill({ json: { ok: true, accountId, created: true } });
    },
  );
  await browser.route(
    `${backend}/${accountId}/connections/simkl/sources`,
    (route) => route.fulfill({ json: { sources: [] } }),
  );
  await routeResolve(browser, () => resolved("imdb", "ls99123456", "list"));

  await app.open("/configure");
  await screen.getByLabel(PASTE).fill("https://www.imdb.com/list/ls99123456/");
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("IMDb · List · ls99123456")).toBeVisible();
  await screen
    .getByRole("listitem")
    .filter({ hasText: "Simkl" })
    .getByRole("button", "Connect")
    .tap();

  await expect(
    screen.getByText("Simkl is connected. You can now add its lists."),
  ).toBeVisible();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  expect(created).toEqual([]);
  expect(completions).toEqual([
    {
      state: "fixture-state",
      code: "fixture-code",
      browserKey: "fixture-browser-key",
      setup: expect.objectContaining({
        lists: [
          expect.objectContaining({
            provider: "imdb",
            sourceRef: "ls99123456",
          }),
        ],
      }) as unknown,
    },
  ]);
});

test("a consent answer that this browser did not start connects nothing", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const completions: string[] = [];
  await browser.route(`${backend}/connections/*/complete`, async (route) => {
    completions.push(route.request.url);
    await route.fulfill({ json: { ok: true, accountId, created: false } });
  });

  // Someone else started this connect and sent the consent link.
  await app.open("/configure#oauth=trakt&state=foreign-state&code=victim-code");

  await expect(
    screen.getByText(
      "This connection was not started in this browser, so nothing was connected. Start it again from your configure page.",
    ),
  ).toBeVisible();
  await expect(browser).toHaveURL("/configure");
  expect(completions).toEqual([]);
});

test("the upgrade keeps unsaved edits and locks the old page", async ({
  app,
  browser,
  screen,
}) => {
  const saves = await captureConfig(browser, legacyConfiguration, imdbUser);
  const created = await routeCreateAccount(browser);
  const upgrades: string[] = [];
  await browser.route(`${backend}/${imdbUser}/upgrade`, async (route) => {
    upgrades.push(route.request.method);
    await route.fulfill({ json: { ok: true, accountId } });
  });

  await app.open(`/configure?account=${imdbUser}`);
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Edited before the upgrade");
  await screen.getByRole("button", "Create my private URL").tap();

  await expect(
    screen.getByRole("heading", "Your private Addon URL is ready"),
  ).toBeVisible();
  // The private copy is made from what the page shows, edits included.
  expect(upgrades).toEqual([]);
  expect(created).toHaveLength(1);
  expect(created[0].lists).toMatchObject([
    { sourceRef: imdbUser, catalogTitle: "Edited before the upgrade" },
  ]);
  // The old page cannot keep saving into the install that the user leaves.
  await expect(screen.getByLabel(PASTE)).toBeDisabled();
  await expect(saveButton(screen)).toBeDisabled();
  expect(saves).toEqual([]);
});
