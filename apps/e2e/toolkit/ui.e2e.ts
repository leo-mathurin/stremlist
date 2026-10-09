import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  AccountConfigInput,
  AccountConfigResponse,
} from "@stremlist/shared/stremio.types";
import {
  SAVED_REINSTALL,
  SAVED_WITH_CHANGES,
  accountId,
  backend,
  baseRoutes,
  captureConfig,
  configuration,
  dragSecondAboveFirst,
  imdbUser,
  legacyConfiguration,
  parseBody,
  resolved,
  routeResolve,
  row,
  savedLists,
  toJson,
  saveButton,
  SAVE_NEW,
  holdToasts,
  fitConfigurePage,
} from "./config-fixture";

const PASTE = "Paste a link to a watchlist or list";
const addonUrl = (key: string) => `${backend}/${key}/manifest.json`;
const second = {
  ...row,
  id: "00000000-0000-4000-8000-000000000002",
  sourceRef: "ls99123456",
  catalogTitle: "Second catalog",
  position: 1,
};
const twoLists = { ...configuration, lists: [row, second] };
const watchlistLink = `https://www.imdb.com/user/${imdbUser}/watchlist`;
const listLink = "https://www.imdb.com/list/ls99123456/";

/** Resolve the two fixture IMDb links like the backend does. */
async function resolveFixtureLinks(browser: Browser) {
  return routeResolve(browser, (input) =>
    input === watchlistLink
      ? resolved("imdb", imdbUser, "watchlist")
      : input === listLink
        ? resolved("imdb", "ls99123456", "list")
        : { ok: false, reason: "not_found", provider: "imdb" },
  );
}

/** Hold every save until the test releases it. */
async function gatedSaves(browser: Browser, initial: AccountConfigResponse) {
  await baseRoutes(browser);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({ json: toJson(initial) });
      return;
    }
    const submitted = parseBody<AccountConfigInput>(route);
    submissions.push(submitted);
    await gate;
    await route.fulfill({
      json: toJson({ ok: true, lists: savedLists(submitted) }),
    });
  });
  return { submissions, release: () => release() };
}

test("public pages and unknown routes provide navigation", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  for (const [path, heading] of [
    ["/", "Your lists, all in Stremio."],
    ["/terms", "Terms and privacy"],
    ["/changelog", "Changelog"],
    ["/unknown", "Page not found"],
  ] as const) {
    await app.open(path);
    await expect(screen.getByRole("heading", heading)).toBeVisible();
  }
  await screen.getByRole("link", "Return to home").tap();
  await expect(browser).toHaveURL("/");
});

test("Home detects the Provider of a link and clearing it resets the entry", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  await app.open("/");
  const field = screen.getByLabel(PASTE);
  await field.fill("banana");
  await expect(
    screen.getByText("No supported site recognized yet."),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Add this list")).toBeVisible();
  await field.fill(watchlistLink);
  await expect(screen.getByText("IMDb watchlist detected")).toBeVisible();
  await field.fill("https://trakt.tv/users/someone/lists/weekend");
  await expect(screen.getByText("Trakt list detected")).toBeVisible();
  await field.fill(addonUrl(accountId));
  await expect(screen.getByText("Addon URL detected")).toBeVisible();
  await field.fill("https://letterboxd.com/someone/watchlist/");
  await expect(screen.getByText("Letterboxd: coming soon")).toBeVisible();
  await field.fill("");
  await expect(screen.getByRole("button", "Build my Stremlist")).toBeVisible();
  // An empty field shows no hint.
  await expect(screen.getByText("Letterboxd: coming soon")).toBeHidden();
  await expect(
    screen.getByText("No supported site recognized yet."),
  ).toBeHidden();
  await expect(browser).toHaveURL("/");
});

test(
  "profile URLs resolve to canonical install URLs",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await fitConfigurePage(browser);
    await baseRoutes(browser);
    const profile = "https://www.imdb.com/user/p.example/";
    const inputs = await routeResolve(browser, (input) =>
      input === profile ? resolved("imdb", imdbUser, "watchlist") : null,
    );
    const created: AccountConfigInput[] = [];
    await browser.route(`${backend}/accounts`, async (route) => {
      const body = parseBody<AccountConfigInput>(route);
      created.push(body);
      await route.fulfill({
        json: toJson({ ok: true, accountId, lists: savedLists(body) }),
      });
    });
    await browser.route(`${backend}/${accountId}/config`, async (route) => {
      await route.fulfill({
        json: {
          ...configuration,
          lists: [{ ...row, catalogTitle: "IMDb Watchlist" }],
        },
      });
    });
    await app.open("/");
    await agent.act(
      "Set up the addon using IMDb profile {profile}. Stop when installation choices appear; do not open Stremio.",
      { params: { profile }, maxModelCalls: 7 },
    );
    await expect(
      screen.getByRole("heading", "Your Stremlist is ready"),
    ).toBeVisible();
    // Stremio opens `stremio://` links over HTTPS without a port, so the
    // local http://127.0.0.1:4314 Addon URL has no app install link.
    await expect(screen.getByRole("link", "Install in Stremio")).toHaveCount(0);
    await expect(screen.getByRole("link", "Open Stremio Web")).toHaveAttribute(
      "href",
      `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonUrl(accountId))}`,
    );
    await expect(browser).toHaveURL(`/configure?account=${accountId}`);
    expect(inputs).toEqual([{ input: profile }]);
    expect(created).toHaveLength(1);
    expect(created[0].lists).toMatchObject([
      { provider: "imdb", sourceRef: imdbUser, position: 0 },
    ]);
  },
);

for (const state of ["private", "unknown", "offline"] as const) {
  test(`link validation reports ${state} watchlists`, async ({
    app,
    screen,
    browser,
  }) => {
    await baseRoutes(browser);
    await routeResolve(browser, () =>
      state === "offline"
        ? null
        : {
            ok: false,
            reason: state === "private" ? "private" : "not_found",
            provider: "imdb",
          },
    );
    await app.open("/configure");
    await screen.getByLabel(PASTE).fill(watchlistLink);
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(
      screen.getByText(
        state === "private"
          ? "This IMDb watchlist is private. Make your watchlist public in your IMDb account settings."
          : state === "unknown"
            ? "IMDb could not find this watchlist. Check the link. The list may have been deleted."
            : "Could not check this link. Please try again in a moment.",
      ),
    ).toBeVisible();
    await expect(screen.getByText("No Lists yet")).toBeVisible();
    await expect(saveButton(screen, SAVE_NEW)).toBeDisabled();
    await expect(
      screen.getByRole("link", "Open Stremio Web"),
    ).not.toBeVisible();
  });
}

test(
  "returning users can open configuration",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await fitConfigurePage(browser);
    await captureConfig(browser);
    await app.open("/");
    await agent.act("Open my existing Stremlist with the Addon URL {url}.", {
      params: { url: addonUrl(accountId) },
      maxModelCalls: 5,
    });
    await expect(browser).toHaveURL(`/configure?account=${accountId}`);
    await expect(screen.getByText("Test catalog")).toBeVisible();
    await expect(
      screen.getByRole("heading", "Install or reinstall in Stremio"),
    ).toBeVisible();
  },
);

test("configuration handles missing Accounts and load retry", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  // Development builds load twice, so the state is a flag, not a count.
  let unavailable = true;
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    await route.fulfill({
      status: unavailable ? 503 : 404,
      json: { error: "test" },
    });
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(
    screen.getByText("Could not load your configuration. Please try again."),
  ).toBeVisible();
  unavailable = false;
  await screen.getByRole("button", "Try again").tap();
  await expect(
    screen.getByText("We could not find this Stremlist"),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Save")).not.toBeVisible();
});

test("List edits reject duplicates, save values and report refresh failures", async ({
  app,
  screen,
  browser,
}) => {
  const submissions = await captureConfig(browser);
  await resolveFixtureLinks(browser);
  await browser.route(`${backend}/${accountId}/refresh`, async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        failed: 1,
        refreshed: 0,
        total: 1,
        lastFetchedAt: configuration.lastFetchedAt,
        cooldownSeconds: 2,
      },
    });
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("Test catalog")).toBeVisible();
  // The watchlist of the existing List, pasted again.
  await screen.getByLabel(PASTE).fill(watchlistLink);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(
    screen.getByText("This list is already in your Stremlist."),
  ).toBeVisible();
  await expect(screen.getByText("1 of 10 lists")).toBeVisible();
  await screen.getByLabel(PASTE).fill(listLink);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("IMDb · List · ls99123456")).toBeVisible();
  await screen.getByRole("button", "Settings for IMDb List").tap();
  await screen.getByLabel("Catalog title").nth(1).fill("My movies");
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions[0].lists).toMatchObject([
    { provider: "imdb", sourceRef: imdbUser, position: 0 },
    {
      provider: "imdb",
      sourceRef: "ls99123456",
      catalogTitle: "My movies",
      position: 1,
    },
  ]);
  // The second save changes nothing. Stremio still needs the reinstall.
  await saveButton(screen).tap();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await screen.getByRole("button", "Remove My movies").tap();
  await expect(screen.getByText("1 of 10 lists")).toBeVisible();
  // An Account keeps at least one List: without one, Save is off.
  await screen.getByRole("button", "Remove Test catalog").tap();
  await expect(screen.getByText("No Lists yet")).toBeVisible();
  await expect(saveButton(screen)).toBeDisabled();
  await screen.getByRole("button", "Refresh now").tap();
  await expect(
    screen.getByText("Refreshed 0 of 1 lists. Some lists failed to update."),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
});

for (const result of ["success", "server-error", "offline"] as const) {
  test(
    `newsletter validates email and handles ${result}`,
    { tags: result === "success" ? ["agent"] : [] },
    async ({ app, agent, screen, browser }) => {
      await holdToasts(browser);
      let submissions = 0;
      await browser.route(
        "http://127.0.0.1:4314/newsletter/subscribe",
        async (route) => {
          submissions += 1;
          expect(JSON.parse(route.request.postData ?? "{}")).toEqual({
            email: "e2e@example.test",
          });
          if (result === "offline") await route.abort();
          else
            await route.fulfill({
              json:
                result === "success"
                  ? { success: true, message: "Test subscription confirmed" }
                  : { success: false, error: "Test service unavailable" },
            });
        },
      );
      await app.open("/");
      await screen.getByRole("button", "Subscribe", { exact: true }).tap();
      await expect(
        screen.getByText("Please enter a valid email address."),
      ).toBeVisible();
      expect(submissions).toBe(0);
      if (result === "success") {
        await agent.act("Subscribe {email} to the newsletter.", {
          params: { email: "e2e@example.test" },
          maxModelCalls: 5,
        });
      } else {
        await screen
          .getByPlaceholder("your@email.com")
          .fill("e2e@example.test");
        await screen.getByRole("button", "Subscribe", { exact: true }).tap();
      }
      await expect(
        screen.getByText(
          result === "success"
            ? "Test subscription confirmed"
            : result === "server-error"
              ? "Test service unavailable"
              : "Network error. Please try again.",
        ),
      ).toBeVisible();
      expect(submissions).toBe(1);
    },
  );
}

for (const entry of ["typed", "query"] as const) {
  test(`onboarding ${entry} entry rejects a failed configuration lookup`, async ({
    app,
    screen,
    browser,
  }) => {
    await baseRoutes(browser);
    const key = entry === "typed" ? accountId : imdbUser;
    let configRequests = 0;
    let accountCreations = 0;
    await browser.route(`${backend}/${key}/config`, async (route) => {
      configRequests += 1;
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    });
    await browser.route(`${backend}/accounts`, async (route) => {
      accountCreations += 1;
      await route.fulfill({ status: 500, json: { error: "Not expected" } });
    });
    if (entry === "typed") {
      await app.open("/");
      await screen.getByRole("button", "Open it").tap();
      await screen.getByLabel("Your Addon URL").fill(addonUrl(key));
      await screen.getByRole("button", "Open", { exact: true }).tap();
    } else {
      // Old links sent returning users to /?userId=ur…
      await app.open(`/?userId=${key}`);
    }
    await expect(
      screen.getByText("Could not load your configuration. Please try again."),
    ).toBeVisible();
    expect(configRequests).toBeGreaterThan(0);
    // A failed lookup must not turn an existing install into a new setup.
    await expect(saveButton(screen, SAVE_NEW)).not.toBeVisible();
    await expect(
      screen.getByRole("link", "Open Stremio Web"),
    ).not.toBeVisible();
    await expect(screen.getByLabel(PASTE)).not.toBeVisible();
    await expect(browser).toHaveURL(`/configure?account=${key}`);
    expect(accountCreations).toBe(0);
  });
}

test(
  "built-in charts avoid duplicates and enforce the List limit",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await fitConfigurePage(browser);
    await captureConfig(browser);
    await app.open(`/configure?account=${accountId}`);
    await agent.act("Add the built-in IMDb chart Top 250 Movies.", {
      maxModelCalls: 5,
    });
    await expect(
      screen.getByRole("button", "Remove Top 250 Movies"),
    ).toBeVisible();
    await expect(screen.getByText(/^2 of 10 lists/)).toBeVisible();
    await screen.getByRole("button", "Add an IMDb chart").tap();
    await expect(
      screen.getByRole("menuitem", /^Top 250 Movies/),
    ).toBeDisabled();
    await browser.keyboard.press("Escape");
    for (const chart of [
      "Most Popular Movies",
      "Most Popular TV Shows",
      "Top 250 TV Shows",
      "Box Office \\(Weekend\\)",
      "Coming Soon \\(Movies\\)",
      "Coming Soon \\(TV\\)",
    ]) {
      await screen.getByRole("button", "Add an IMDb chart").tap();
      await screen.getByRole("menuitem", new RegExp(`^${chart}`)).tap();
    }
    await screen.getByRole("button", "Trending").tap();
    await screen.getByRole("button", "Popular").tap();
    await expect(screen.getByText(/^10 of 10 lists/)).toBeVisible();
    await expect(
      screen.getByRole("button", "Add an IMDb chart"),
    ).toBeDisabled();
    await expect(screen.getByRole("button", "Anticipated")).toBeDisabled();
    await expect(screen.getByLabel(PASTE)).toBeDisabled();
    await expect(
      screen.getByText(
        "You have 10 lists, the maximum. Remove one to add another.",
      ),
    ).toBeVisible();
    await expect(screen.getByRole("button", /^Remove /)).toHaveCount(10);
  },
);

test("save errors preserve changes and allow a successful retry", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  let rejected = true;
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "POST") {
      const submitted = parseBody<AccountConfigInput>(route);
      await route.fulfill({
        status: rejected ? 400 : 200,
        json: rejected
          ? { error: "Test save rejected" }
          : toJson({ ok: true, lists: savedLists(submitted) }),
      });
    } else await route.fulfill({ json: configuration });
  });
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Updated catalog");
  await saveButton(screen).tap();
  await expect(screen.getByText("Test save rejected")).toBeVisible();
  await expect(screen.getByLabel("Catalog title")).toHaveValue(
    "Updated catalog",
  );
  rejected = false;
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
});

test("successful refresh applies cooldown and blocks another refresh", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(browser);
  let refreshes = 0;
  await browser.route(`${backend}/${accountId}/refresh`, async (route) => {
    refreshes += 1;
    await route.fulfill({
      json: {
        ok: true,
        failed: 0,
        refreshed: 1,
        total: 1,
        lastFetchedAt: new Date().toISOString(),
        cooldownSeconds: 60,
      },
    });
  });
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Refresh now").tap();
  await expect(screen.getByRole("button", /Refresh in \d+s/)).toBeDisabled();
  expect(refreshes).toBe(1);
});

test(
  "RPDB key visibility control hides the key again",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await fitConfigurePage(browser);
    await captureConfig(browser);
    await app.open(`/configure?account=${accountId}`);
    await expect(screen.getByRole("button", "Show RPDB API key")).toBeVisible();
    await agent.act("Reveal the RPDB API key using its visibility control.", {
      maxModelCalls: 4,
    });
    await expect(screen.getByLabel(/^RPDB API key/)).toHaveAttribute(
      "type",
      "text",
    );
    await agent.act("Hide the RPDB API key again.", { maxModelCalls: 4 });
    await expect(screen.getByRole("button", "Show RPDB API key")).toBeVisible();
  },
);

test(
  "clipboard denial offers manual Addon URL copy",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await fitConfigurePage(browser);
    await captureConfig(browser);
    await browser.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () =>
          Promise.reject(new DOMException("Denied", "NotAllowedError")),
      });
    });
    await app.open(`/configure?account=${accountId}`);
    await agent.act(
      "Try to copy this addon's Addon URL with its copy control. Stop after the attempt, even if the browser refuses clipboard access.",
      { maxModelCalls: 4 },
    );
    await expect(
      screen.getByText(
        "Could not copy the Addon URL. Select it and copy it manually.",
      ),
    ).toBeVisible();
  },
);

test("pointer reorder changes visible List order and saved positions", async ({
  app,
  screen,
  browser,
}) => {
  const submissions = await captureConfig(browser, twoLists);
  await browser.setViewport({ width: 1280, height: 1800 });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("button", /^Drag to reorder/)).toHaveCount(2);
  await dragSecondAboveFirst(browser);
  await expect(screen.getByText(/^(Test|Second) catalog$/)).toHaveText([
    "Second catalog",
    "Test catalog",
  ]);
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions[0].lists).toMatchObject([
    { sourceRef: "ls99123456", catalogTitle: "Second catalog", position: 0 },
    { sourceRef: imdbUser, catalogTitle: "Test catalog", position: 1 },
  ]);
});

test(
  "catalog filters and extra presets survive save and clear",
  { tags: ["agent"] },
  async ({ app, agent, screen, browser }) => {
    await holdToasts(browser);
    const submissions = await captureConfig(browser);
    await fitConfigurePage(browser);
    await app.open(`/configure?account=${accountId}`);
    await agent.act(
      "For the Test catalog, select the Drama genre filter and enable the Top rated extra catalog, then save these settings.",
      { maxModelCalls: 12 },
    );
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    expect(submissions.at(-1)?.lists[0].catalogSettings).toEqual({
      genre: "Drama",
      presets: ["rated"],
    });
    await agent.act(
      "Clear this catalog's filters while keeping the Top rated extra catalog enabled, then save.",
      { maxModelCalls: 6 },
    );
    // The first save added the Top rated catalog, and Stremio still needs
    // the reinstall, so the second save keeps the reinstall message.
    await expect.poll(() => submissions.length).toBe(2);
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    expect(submissions.at(-1)?.lists[0].catalogSettings).toEqual({
      presets: ["rated"],
    });
  },
);

test("edits made while saving remain available for the next save", async ({
  app,
  screen,
  browser,
}) => {
  const { submissions, release } = await gatedSaves(browser, configuration);
  await resolveFixtureLinks(browser);
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Submitted title");
  await saveButton(screen).tap();
  await expect(saveButton(screen, "Saving")).toBeVisible();
  await screen.getByLabel("Catalog title").fill("New unsaved title");
  await screen.getByLabel(PASTE).fill(listLink);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("IMDb · List · ls99123456")).toBeVisible();
  await screen.getByLabel(/^RPDB API key/).fill("e2e-synthetic-rpdb");
  release();
  await expect(screen.getByText(SAVED_WITH_CHANGES)).toBeVisible();
  await expect(screen.getByLabel("Catalog title").first()).toHaveValue(
    "New unsaved title",
  );
  await expect(screen.getByRole("button", /^Remove /)).toHaveCount(2);
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(submissions[0]).toMatchObject({
    lists: [{ catalogTitle: "Submitted title" }],
  });
  expect(submissions[1]).toMatchObject({
    rpdbApiKey: "e2e-synthetic-rpdb",
    lists: [
      { sourceRef: imdbUser, catalogTitle: "New unsaved title", position: 0 },
      { sourceRef: "ls99123456", position: 1 },
    ],
  });
});

for (const edit of ["remove", "reorder"] as const) {
  test(`${edit} during save preserves current List structure`, async ({
    app,
    screen,
    browser,
  }) => {
    const { submissions, release } = await gatedSaves(browser, twoLists);
    await browser.setViewport({ width: 1280, height: 1800 });
    await app.open(`/configure?account=${accountId}`);
    await saveButton(screen).tap();
    await expect(saveButton(screen, "Saving")).toBeVisible();
    if (edit === "remove") {
      await screen.getByRole("button", "Remove Test catalog").tap();
    } else {
      await dragSecondAboveFirst(browser);
    }
    await expect(screen.getByText(/^(Test|Second) catalog$/)).toHaveText(
      edit === "remove"
        ? ["Second catalog"]
        : ["Second catalog", "Test catalog"],
    );
    release();
    await expect(screen.getByText(SAVED_WITH_CHANGES)).toBeVisible();
    await expect(screen.getByRole("button", /^Remove /)).toHaveCount(
      edit === "remove" ? 1 : 2,
    );
    await expect(
      screen.getByText(/^(Test|Second) catalog$/).first(),
    ).toHaveText("Second catalog");
    await saveButton(screen).tap();
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    expect(submissions.at(-1)?.lists).toMatchObject(
      edit === "remove"
        ? [{ sourceRef: "ls99123456", position: 0 }]
        : [
            { sourceRef: "ls99123456", position: 0 },
            { sourceRef: imdbUser, position: 1 },
          ],
    );
  });
}

test("an old ?userId link opens the Legacy alias install with a fresh form", async ({
  app,
  screen,
  browser,
}) => {
  await captureConfig(browser, legacyConfiguration, imdbUser);
  await app.open(`/?userId=${imdbUser}`);
  await expect(browser).toHaveURL(`/configure?account=${imdbUser}`);
  await expect(screen.getByText(`IMDb install ${imdbUser}`)).toBeVisible();
  await expect(screen.getByText("Test catalog")).toBeVisible();
  await expect(
    screen.getByRole("heading", "Upgrade to a private URL"),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Actions need a private Addon URL. Upgrade this install first.",
    ),
  ).toBeVisible();
  await expect(saveButton(screen)).toBeEnabled();
});
