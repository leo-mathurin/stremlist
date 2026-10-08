import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  AccountConfigInput,
  AccountConfigResponse,
} from "@stremlist/shared/stremio.types";
import {
  SAVED_REINSTALL,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  connected,
  imdbUser,
  legacyConfiguration,
  parseBody,
  providerStatus,
  resolved,
  routeResolve,
  row,
  savedLists,
  toJson,
} from "./config-fixture";

// Provider journeys of the configure page: links of every available Provider
// (Letterboxd is out of scope), Connections and their OAuth round trip,
// disconnect, Actions settings and the Legacy alias upgrade. The API is
// intercepted; tests/provider-journeys.spec.ts runs the real backend.

const PASTE = "Paste a link to a watchlist or list";
const app4311 = "http://127.0.0.1:4311";
const connectedAt = "2026-10-01T00:00:00.000Z";
const traktList = {
  ...row,
  id: "00000000-0000-4000-8000-000000000003",
  provider: "trakt",
  sourceRef: "me/watchlist",
  catalogTitle: "Trakt Watchlist",
  position: 1,
} as const;

/**
 * Serve an OAuth authorize page that sends the browser straight back to the
 * configure page, as the Provider does after the user agrees.
 */
async function routeAuthorize(
  browser: Browser,
  pattern: string,
  back: string,
  seen: string[],
) {
  await browser.route(pattern, async (route) => {
    seen.push(route.request.url);
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Authorize</title><script>location.replace(${JSON.stringify(back)})</script>`,
    });
  });
}

/** A configuration that the test can change while the page is open. */
async function liveConfig(browser: Browser, initial: AccountConfigResponse) {
  const state = { config: initial };
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({ json: toJson(state.config) });
      return;
    }
    const submitted = parseBody<AccountConfigInput>(route);
    submissions.push(submitted);
    await route.fulfill({
      json: toJson({ ok: true, lists: savedLists(submitted) }),
    });
  });
  return { state, submissions };
}

test("pasted links of every available Provider become Lists of a new setup", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const links = {
    trakt: "https://trakt.tv/users/someone/watchlist",
    justwatch:
      "https://www.justwatch.com/us/lists/tl-us-11111111-2222-4333-8444-555555555555",
    senscritique:
      "https://www.senscritique.com/someone/collection?action=WISH&universe=1",
    imdb: "https://www.imdb.com/list/ls99123456/",
  };
  const inputs = await routeResolve(browser, (input) => {
    switch (input) {
      case links.trakt:
        return resolved("trakt", "users/someone/watchlist", "watchlist", {
          suggestedTitle: "someone's watchlist",
        });
      case links.justwatch:
        return resolved(
          "justwatch",
          "tl-us-11111111-2222-4333-8444-555555555555",
          "list",
          { suggestedTitle: "Weekend picks", defaultDisplayMode: "movie" },
        );
      case links.senscritique:
        return resolved("senscritique", "users/someone/wishes", "watchlist", {
          suggestedTitle: "someone's wishlist",
        });
      case links.imdb:
        return resolved("imdb", "ls99123456", "list");
      default:
        return { ok: false, reason: "unrecognized" };
    }
  });
  const created: AccountConfigInput[] = [];
  await browser.route(`${backend}/accounts`, async (route) => {
    const body = parseBody<AccountConfigInput>(route);
    created.push(body);
    await route.fulfill({
      json: toJson({ ok: true, accountId, lists: savedLists(body) }),
    });
  });
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    await route.fulfill({ json: toJson(configuration) });
  });
  await app.open("/configure");
  const field = screen.getByLabel(PASTE);
  for (const [link, hint, row] of [
    [links.trakt, "Trakt watchlist detected", "Trakt · Watchlist · someone"],
    [
      links.justwatch,
      "JustWatch list detected",
      "JustWatch · List · Shared list",
    ],
    [
      links.senscritique,
      "SensCritique watchlist detected",
      "SensCritique · Watchlist · someone",
    ],
    [links.imdb, "IMDb list detected", "IMDb · List · ls99123456"],
  ] as const) {
    await field.fill(link);
    await expect(screen.getByText(hint)).toBeVisible();
    await expect(screen.getByText("Link detected")).toBeVisible();
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(screen.getByText(row)).toBeVisible();
    await expect(field).toHaveValue("");
  }
  await expect(screen.getByText(/^4 of 10 lists/)).toBeVisible();
  await screen.getByRole("button", "Save and get my Addon URL").tap();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  expect(inputs.map((entry) => entry.input)).toEqual(Object.values(links));
  expect(created[0].lists).toMatchObject([
    {
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
      catalogTitle: "someone's watchlist",
      position: 0,
    },
    {
      provider: "justwatch",
      sourceRef: "tl-us-11111111-2222-4333-8444-555555555555",
      catalogTitle: "Weekend picks",
      displayMode: "movie",
      position: 1,
    },
    {
      provider: "senscritique",
      sourceRef: "users/someone/wishes",
      catalogTitle: "someone's wishlist",
      position: 2,
    },
    { provider: "imdb", sourceRef: "ls99123456", position: 3 },
  ]);
});

test(
  "a Provider chart is added from Quick add",
  { tags: ["agent"] },
  async ({ app, agent, browser, screen }) => {
    const submissions = await captureConfig(browser);
    await app.open(`/configure?account=${accountId}`);
    await agent.act("Add the Trakt Trending chart to my Lists, then save.", {
      maxModelCalls: 5,
    });
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    await expect(screen.getByRole("button", "Trending")).toBeDisabled();
    expect(submissions.at(-1)?.lists).toMatchObject([
      { provider: "imdb", sourceRef: imdbUser },
      {
        provider: "trakt",
        sourceRef: "trending",
        catalogTitle: "Trakt Trending",
        position: 1,
      },
    ]);
  },
);

test("a link that needs a Connection saves the setup, connects, then adds the link", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const link = "https://mdblist.com/lists/someone/weekend";
  const inputs = await routeResolve(browser, (input, accountKey) =>
    input !== link
      ? null
      : accountKey === accountId
        ? resolved("mdblist", "lists/4242", "list", {
            suggestedTitle: "Weekend",
          })
        : { ok: false, reason: "needs_connection", provider: "mdblist" },
  );
  const created: AccountConfigInput[] = [];
  await browser.route(`${backend}/accounts`, async (route) => {
    const body = parseBody<AccountConfigInput>(route);
    created.push(body);
    await route.fulfill({ json: { ok: true, accountId, lists: [] } });
  });
  const starts: string[] = [];
  await browser.route(
    `${backend}/${accountId}/connections/mdblist/start`,
    async (route) => {
      starts.push(route.request.method);
      await route.fulfill({
        json: {
          ok: true,
          authorizeUrl:
            "https://mdblist.com/oauth/authorize?client_id=fixture&state=fixture-state",
        },
      });
    },
  );
  const authorized: string[] = [];
  await routeAuthorize(
    browser,
    "https://mdblist.com/oauth/**",
    `${app4311}/configure?account=${accountId}&connected=mdblist`,
    authorized,
  );
  await liveConfig(browser, {
    ...configuration,
    lists: [],
    connections: [connected("mdblist")],
  });
  await browser.route(
    `${backend}/${accountId}/connections/mdblist/sources`,
    async (route) => {
      await route.fulfill({
        json: {
          sources: [
            {
              ref: "me/watchlist",
              kind: "watchlist",
              label: "Watchlist",
              defaultDisplayMode: "split",
            },
            {
              ref: "me/lists/77",
              kind: "list",
              label: "Horror nights",
              defaultDisplayMode: "movie",
            },
          ],
        },
      });
    },
  );

  await app.open("/configure");
  await screen.getByLabel(PASTE).fill(link);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(
    screen.getByText(
      "This list needs your MDBList account. Connect MDBList to add it. Stremlist saves your setup first to create your private Addon URL.",
    ),
  ).toBeVisible();
  await screen.getByRole("button", "Connect MDBList").tap();
  await expect(
    screen.getByText("MDBList is connected. You can now add its lists."),
  ).toBeVisible();
  await expect(browser).toHaveURL(`/configure?account=${accountId}`);
  // The link waited during the round trip and is added with the Connection.
  await expect(screen.getByText("Weekend")).toBeVisible();
  await expect(screen.getByText("@someone")).toBeVisible();
  await expect(screen.getByText("Your MDBList (@someone)")).toBeVisible();
  await expect(screen.getByRole("button", "Horror nights")).toBeVisible();
  expect(created).toEqual([{ rpdbApiKey: "", lists: [] }]);
  expect(starts).toEqual(["POST"]);
  expect(authorized).toHaveLength(1);
  expect(inputs).toEqual([
    { input: link },
    { input: link, accountKey: accountId },
  ]);
});

for (const [error, message] of [
  ["denied", "You cancelled the connection to Trakt. Nothing changed."],
  ["expired", "The connection to Trakt took too long. Please try again."],
  ["failed", "Could not connect Trakt. Please try again."],
] as const) {
  test(`an OAuth return with ${error} explains what happened`, async ({
    app,
    browser,
    screen,
  }) => {
    await captureConfig(browser);
    await app.open(
      `/configure?account=${accountId}&connection_error=${error}&provider=trakt`,
    );
    await expect(screen.getByText(message)).toBeVisible();
    await expect(browser).toHaveURL(`/configure?account=${accountId}`);
    await screen.getByRole("button", "Dismiss").tap();
    await expect(screen.getByText(message)).not.toBeVisible();
  });
}

test(
  "disconnecting a Provider asks first, then its Lists offer to connect again",
  { tags: ["agent"] },
  async ({ app, agent, browser, screen }) => {
    await baseRoutes(
      browser,
      providerStatus({
        simkl: { connectable: false },
        mdblist: { connectable: false },
      }),
    );
    const { state, submissions } = await liveConfig(browser, {
      ...configuration,
      lists: [row, traktList],
      connections: [connected("trakt")],
      actions: { enabled: true, providers: ["trakt"] },
    });
    await browser.route(
      `${backend}/${accountId}/connections/trakt/sources`,
      async (route) => {
        await route.fulfill({ json: { sources: [] } });
      },
    );
    const deletes: string[] = [];
    await browser.route(
      `${backend}/${accountId}/connections/trakt`,
      async (route) => {
        deletes.push(route.request.method);
        state.config = { ...state.config, connections: [] };
        await route.fulfill({ json: { ok: true } });
      },
    );
    const starts: string[] = [];
    await browser.route(
      `${backend}/${accountId}/connections/trakt/start`,
      async (route) => {
        starts.push(route.request.method);
        await route.fulfill({
          json: {
            ok: true,
            authorizeUrl: "https://auth.trakt.tv/oauth/authorize?state=again",
          },
        });
      },
    );
    const authorized: string[] = [];
    await routeAuthorize(
      browser,
      "https://auth.trakt.tv/oauth/**",
      `${app4311}/configure?account=${accountId}&connection_error=denied&provider=trakt`,
      authorized,
    );
    await app.open(`/configure?account=${accountId}`);
    await expect(screen.getByText("@someone")).toBeVisible();
    await screen.getByRole("button", "Disconnect").tap();
    const confirm = screen.getByRole("group", "Disconnect Trakt?");
    await expect(
      confirm.getByText(
        "1 List is read through this account. It stops showing in Stremio until you connect Trakt again. Actions on Trakt stop too.",
        { exact: false },
      ),
    ).toBeVisible();
    await confirm.getByRole("button", "Cancel").tap();
    await expect(confirm).not.toBeVisible();
    expect(deletes).toEqual([]);
    await agent.act("Disconnect Trakt and confirm it.", { maxModelCalls: 5 });
    await expect(
      screen.getByText(
        "Trakt is disconnected. Lists read through Trakt stop showing in Stremio until you connect it again.",
      ),
    ).toBeVisible();
    expect(deletes).toEqual(["DELETE"]);
    await expect(
      screen.getByText(
        "Trakt is not connected, so this List does not show in Stremio.",
      ),
    ).toBeVisible();
    await expect(
      screen.getByText("Connect Trakt, Simkl or MDBList to use Actions."),
    ).toBeVisible();
    await screen.getByRole("button", "Save", { exact: true }).tap();
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    expect(submissions.at(-1)?.actions).toEqual({
      enabled: true,
      providers: [],
    });
    await screen
      .getByRole("button", "Connect again for Trakt Watchlist", { exact: true })
      .tap();
    await expect(
      screen.getByText(
        "You cancelled the connection to Trakt. Nothing changed.",
      ),
    ).toBeVisible();
    expect(starts).toEqual(["POST"]);
    expect(authorized).toHaveLength(1);
  },
);

test("Actions settings save the chosen Providers in their order", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  const { submissions } = await liveConfig(browser, {
    ...configuration,
    connections: [connected("trakt"), connected("simkl", null)],
  });
  for (const provider of ["trakt", "simkl"]) {
    await browser.route(
      `${backend}/${accountId}/connections/${provider}/sources`,
      async (route) => {
        await route.fulfill({ json: { sources: [] } });
      },
    );
  }
  await app.open(`/configure?account=${accountId}`);
  const toggle = screen.getByRole("checkbox", "Show Actions in Stremio");
  await expect(toggle).not.toBeChecked();
  await expect(screen.getByRole("checkbox", /^Trakt/)).toBeDisabled();
  await toggle.tap();
  await expect(screen.getByRole("checkbox", /^Trakt/)).toBeChecked();
  await expect(screen.getByRole("checkbox", /^Simkl/)).toBeChecked();
  await screen.getByRole("button", "Move Simkl up").tap();
  await screen.getByRole("checkbox", /^Trakt/).tap();
  await expect(screen.getByRole("checkbox", /^Trakt/)).not.toBeChecked();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  // Actions add a stream resource that Stremio reads only at install time.
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions.at(-1)?.actions).toEqual({
    enabled: true,
    providers: ["simkl"],
  });
});

test(
  "a Legacy alias install upgrades to a private Addon URL",
  { tags: ["agent"] },
  async ({ app, agent, browser, screen }) => {
    await captureConfig(browser, legacyConfiguration, imdbUser);
    const newId = "sl_E2eFixtureAccount00003";
    const upgrades: string[] = [];
    await browser.route(`${backend}/${imdbUser}/upgrade`, async (route) => {
      upgrades.push(route.request.method);
      await route.fulfill({ json: { ok: true, accountId: newId } });
    });
    await browser.route(`${backend}/${newId}/config`, async (route) => {
      await route.fulfill({
        json: toJson({ ...configuration, accountId: newId }),
      });
    });
    const starts: string[] = [];
    await browser.route(`${backend}/*/connections/**`, async (route) => {
      starts.push(route.request.url);
      await route.fulfill({ status: 404, json: { error: "Addon not found." } });
    });
    await app.open(`/configure?account=${imdbUser}`);
    // Connections need a private Addon URL: Connect only points to the upgrade.
    await screen.getByRole("button", "Connect").first().tap();
    expect(starts).toEqual([]);
    await expect(
      screen.getByText(
        "Actions need a private Addon URL. Upgrade this install first.",
      ),
    ).toBeVisible();
    await agent.act(
      "Upgrade this install to a private Addon URL, then open the new configure page.",
      { maxModelCalls: 6 },
    );
    await expect(browser).toHaveURL(`/configure?account=${newId}`);
    await expect(
      screen.getByRole("heading", "Your Stremlist is ready"),
    ).toBeVisible();
    await expect(screen.getByLabel("Addon URL", { exact: true })).toHaveValue(
      `${backend}/${newId}/manifest.json`,
    );
    expect(upgrades).toEqual(["POST"]);
  },
);

test("a Legacy alias install that moved to a private URL cannot be changed", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(
    browser,
    { ...legacyConfiguration, movedAt: connectedAt },
    imdbUser,
  );
  await app.open(`/configure?account=${imdbUser}`);
  await expect(
    screen.getByRole("heading", "This install has a private URL now"),
  ).toBeVisible();
  await expect(
    screen.getByText("Saving is off for this install"),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Save", { exact: true }),
  ).toBeDisabled();
  await expect(screen.getByLabel(PASTE)).toBeDisabled();
  await expect(
    screen.getByRole("button", "Create a new private URL"),
  ).toBeEnabled();
});
