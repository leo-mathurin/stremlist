import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { AccountConfigInput } from "@stremlist/shared/stremio.types";
import {
  SAVED,
  SAVED_REINSTALL,
  SAVED_WITH_CHANGES,
  accountId,
  backend,
  baseRoutes,
  configuration,
  captureConfig,
  imdbUser,
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

test("a canonical duplicate is refused and the link stays for repair", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  // The backend turns the p. handle into the ur… ID of the existing List.
  const inputs = await routeResolve(browser, (input) =>
    input === "https://www.imdb.com/user/p.sameaccount/"
      ? resolved("imdb", imdbUser, "watchlist")
      : resolved("imdb", "ls99887766", "list"),
  );
  await app.open(`/configure?account=${accountId}`);
  const field = screen.getByLabel(PASTE);
  await field.fill("https://www.imdb.com/user/p.sameaccount/");
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(
    screen.getByText("This list is already in your Stremlist."),
  ).toBeVisible();
  await expect(field).toHaveValue("https://www.imdb.com/user/p.sameaccount/");
  await expect(screen.getByText("1 of 10 lists")).toBeVisible();
  await field.fill("https://www.imdb.com/list/ls99887766/");
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(screen.getByText("IMDb · List · ls99887766")).toBeVisible();
  await expect(field).toHaveValue("");
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(inputs.map((entry) => entry.accountKey)).toEqual([
    accountId,
    accountId,
  ]);
  expect(submissions[0].lists.map((list) => list.sourceRef)).toEqual([
    imdbUser,
    "ls99887766",
  ]);
});

for (const failure of ["private", "unknown", "offline"] as const) {
  test(`a new setup recovers from ${failure} with a canonical profile`, async ({
    app,
    browser,
    screen,
  }) => {
    await baseRoutes(browser);
    let recover = false;
    const inputs = await routeResolve(browser, () =>
      recover
        ? resolved("imdb", imdbUser, "watchlist")
        : failure === "offline"
          ? null
          : {
              ok: false,
              reason: failure === "private" ? "private" : "not_found",
              provider: "imdb",
            },
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
      await route.fulfill({ json: configuration });
    });
    await app.open("/configure");
    const field = screen.getByLabel(PASTE);
    await field.fill("invalid");
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(
      screen.getByText(/^We do not recognize this link\./),
    ).toBeVisible();
    expect(inputs).toHaveLength(0);
    await field.fill("ur9999999999999");
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(
      screen.getByText(
        failure === "private"
          ? /^This IMDb watchlist is private/
          : failure === "unknown"
            ? /^IMDb could not find this watchlist/
            : "Could not check this link. Please try again in a moment.",
      ),
    ).toBeVisible();
    await expect(saveButton(screen, SAVE_NEW)).toBeDisabled();
    recover = true;
    await field.fill("https://www.imdb.com/user/p.fixture/");
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(
      screen.getByText(`IMDb · Watchlist · ${imdbUser}`),
    ).toBeVisible();
    await saveButton(screen, SAVE_NEW).tap();
    await expect(browser).toHaveURL(`/configure?account=${accountId}`);
    await expect(screen.getByText("Test catalog")).toBeVisible();
    expect(created).toHaveLength(1);
    expect(created[0].lists).toMatchObject([
      { provider: "imdb", sourceRef: imdbUser },
    ]);
  });
}

test(
  "an unrecognized link adds nothing, then a pasted list URL is added and saved",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    await holdToasts(browser);
    await fitConfigurePage(browser);
    const submissions = await captureConfig(browser, {
      ...configuration,
      lists: [],
    });
    const inputs = await routeResolve(browser, (input) =>
      input === "https://www.imdb.com/list/ls99123456/"
        ? resolved("imdb", "ls99123456", "list")
        : null,
    );
    await app.open(`/configure?account=${accountId}`);
    await screen.getByLabel(PASTE).fill("not-an-imdb-source");
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(
      screen.getByText(/^We do not recognize this link\./),
    ).toBeVisible();
    await expect(screen.getByText("No Lists yet")).toBeVisible();
    await expect(saveButton(screen)).toBeDisabled();
    expect(inputs).toHaveLength(0);
    await agent.act(
      "Replace the unrecognized link with {url} and add it, name its catalog Weekend films, and save.",
      {
        params: { url: "https://www.imdb.com/list/ls99123456/" },
        maxModelCalls: 9,
      },
    );
    // The first List of an Account saved without Lists adds Catalogs, so
    // Stremio needs a reinstall.
    await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
    await expect(screen.getByText("IMDb · List · ls99123456")).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].lists).toMatchObject([
      { sourceRef: "ls99123456", catalogTitle: "Weekend films" },
    ]);
  },
);

test("a normalized handle becomes the saved source and the next save stays clean", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  let requests = 0;
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET")
      await route.fulfill({
        json: { ...configuration, lists: [{ ...row, sourceRef: "p.fixture" }] },
      });
    else {
      requests++;
      const payload = parseBody<AccountConfigInput>(route);
      expect(payload.lists[0].sourceRef).toBe(
        requests === 1 ? "p.fixture" : "ur99887766",
      );
      await route.fulfill({
        json: toJson({
          ok: true,
          lists: savedLists(payload).map((list) => ({
            ...list,
            sourceRef: "ur99887766",
          })),
        }),
      });
    }
  });
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByText("IMDb · Watchlist · p.fixture")).toBeVisible();
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Handle catalog");
  await saveButton(screen).tap();
  await expect(screen.getByText("IMDb · Watchlist · ur99887766")).toBeVisible();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  // Nothing changed since, so the next save sends the stored handle. Stremio
  // still needs the reinstall, so the message stays.
  await saveButton(screen).tap();
  await expect.poll(() => requests).toBe(2);
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await expect(screen.getByText(SAVED_WITH_CHANGES)).toHaveCount(0);
});

test("network save failure preserves values for a retry", async ({
  app,
  browser,
  screen,
}) => {
  await baseRoutes(browser);
  let attempts = 0;
  await browser.route(`${backend}/${accountId}/config`, async (route) => {
    if (route.request.method === "GET")
      await route.fulfill({ json: configuration });
    else if (++attempts === 1) await route.abort();
    else
      await route.fulfill({
        json: toJson({
          ok: true,
          lists: savedLists(parseBody<AccountConfigInput>(route)),
        }),
      });
  });
  await app.open(`/configure?account=${accountId}`);
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Keep my changes");
  await saveButton(screen).tap();
  await expect(
    screen.getByText("Failed to fetch", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByLabel("Catalog title")).toHaveValue(
    "Keep my changes",
  );
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  expect(attempts).toBe(2);
});

test(
  "a saved genre missing from refreshed choices can still be cleared",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    await holdToasts(browser);
    await fitConfigurePage(browser);
    const submissions = await captureConfig(browser, {
      ...configuration,
      lists: [
        {
          ...row,
          availableGenres: [],
          catalogSettings: { genre: "Western", presets: ["rated"] },
        },
      ],
    });
    await app.open(`/configure?account=${accountId}`);
    await screen.getByRole("button", "Settings for Test catalog").tap();
    await screen.getByRole("button", /Filters & extra catalogs/).tap();
    await expect(
      screen.getByRole("combobox", "Genre", { exact: true }),
    ).toHaveText("Western");
    await expect(
      screen.getByRole("combobox", "Genre", { exact: true }),
    ).toBeEnabled();
    await agent.act(
      "Remove the Western genre restriction by selecting All genres. Keep the Top rated extra catalog enabled, and save.",
      { maxModelCalls: 6 },
    );
    await expect(
      screen.getByRole("combobox", "Genre", { exact: true }),
    ).toHaveText("All genres");
    await expect(
      screen.getByRole("checkbox", "Top rated", { exact: true }),
    ).toBeChecked();
    await expect(screen.getByText(SAVED)).toBeVisible();
    expect(submissions[0].lists[0].catalogSettings).toEqual({
      presets: ["rated"],
    });
  },
);
