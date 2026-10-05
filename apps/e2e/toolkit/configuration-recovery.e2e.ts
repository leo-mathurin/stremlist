import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  account,
  backend,
  configuration,
  captureConfig,
  row,
  sourcePlaceholder,
  titlePlaceholder,
} from "./config-fixture";

test("canonical duplicate rejection keeps both rows editable for source repair", async ({
  app,
  browser,
  screen,
}) => {
  let attempts = 0;
  await browser.route(`${backend}/${account}/config`, async (route) => {
    if (route.request.method === "GET")
      await route.fulfill({ json: configuration });
    else {
      attempts++;
      const payload = JSON.parse(route.request.postData ?? "{}");
      expect(
        payload.watchlists.map(
          (item: { imdbUserId: string }) => item.imdbUserId,
        ),
      ).toEqual([account, attempts === 1 ? "p.sameaccount" : "ls99887766"]);
      await route.fulfill({
        status: attempts === 1 ? 400 : 200,
        json:
          attempts === 1
            ? {
                error:
                  "Each watchlist must use a unique IMDb ID for this installation.",
              }
            : { ok: true },
      });
    }
  });
  await app.open(`/configure?userId=${account}`);
  await screen.getByRole("button", "Add Catalog", { exact: true }).tap();
  await screen.getByPlaceholder(sourcePlaceholder).nth(1).fill("p.sameaccount");
  await screen
    .getByPlaceholder(titlePlaceholder)
    .nth(1)
    .fill("Keep this title");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(
      "Each watchlist must use a unique IMDb ID for this installation.",
    ),
  ).toBeVisible();
  await expect(screen.getByPlaceholder(sourcePlaceholder)).toHaveCount(2);
  await expect(screen.getByPlaceholder(titlePlaceholder).nth(1)).toHaveValue(
    "Keep this title",
  );
  await screen.getByPlaceholder(sourcePlaceholder).nth(1).fill("ls99887766");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(/Saved! Catalog structure changed/),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

for (const failure of ["private", "unknown", "offline"] as const) {
  test(`configuration entry recovers from ${failure} with a canonical profile`, async ({
    app,
    browser,
    screen,
  }) => {
    let recover = false;
    await browser.route(`${backend}/validate/**`, async (route) => {
      if (recover)
        await route.fulfill({ json: { valid: true, userId: account } });
      else if (failure === "offline") await route.abort();
      else
        await route.fulfill({
          json: {
            valid: false,
            reason: failure === "private" ? "private" : "not_found",
          },
        });
    });
    await captureConfig(browser);
    await app.open("/configure");
    const input = screen.getByLabel("IMDb User ID:");
    await input.fill("invalid");
    await expect(
      screen.getByText(/Enter a valid IMDb ID starting/),
    ).toBeVisible();
    await input.fill("ur9999999999999");
    await expect(
      screen.getByText(
        failure === "private"
          ? /This IMDb watchlist is private/
          : failure === "unknown"
            ? /This IMDb ID does not exist/
            : /Could not validate this IMDb ID/,
      ),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Save", { exact: true }),
    ).not.toBeVisible();
    recover = true;
    await input.fill("https://www.imdb.com/user/p.fixture/");
    await expect(browser).toHaveURL(`/configure?userId=${account}`);
    await expect(screen.getByPlaceholder(titlePlaceholder)).toHaveValue(
      "Test catalog",
    );
  });
}

test(
  "invalid catalog source blocks save, then a pasted list URL repairs it",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    const submissions = await captureConfig(browser);
    await app.open(`/configure?userId=${account}`);
    await screen.getByPlaceholder(sourcePlaceholder).fill("not-an-imdb-source");
    await expect(
      screen.getByText(/Each watchlist needs a valid IMDb User ID or List ID/),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Save", { exact: true }),
    ).toBeDisabled();
    expect(submissions).toHaveLength(0);
    await agent.act(
      "Repair the invalid catalog source with {url}, name the catalog Weekend films, and save.",
      {
        params: { url: "https://www.imdb.com/list/ls99123456/" },
        maxModelCalls: 7,
      },
    );
    await expect(
      screen.getByText(/Saved! Catalog structure changed/),
    ).toBeVisible();
    await expect(screen.getByPlaceholder(sourcePlaceholder)).toHaveValue(
      "ls99123456",
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0].watchlists).toMatchObject([
      { imdbUserId: "ls99123456", catalogTitle: "Weekend films" },
    ]);
  },
);

test("a normalized handle becomes the saved source and the next save stays clean", async ({
  app,
  browser,
  screen,
}) => {
  let requests = 0;
  await browser.route(`${backend}/${account}/config`, async (route) => {
    if (route.request.method === "GET")
      await route.fulfill({ json: configuration });
    else {
      requests++;
      const payload = JSON.parse(route.request.postData ?? "{}");
      expect(payload.watchlists[0].imdbUserId).toBe(
        requests === 1 ? "p.fixture" : "ur99887766",
      );
      await route.fulfill({
        json: { ok: true, watchlists: [{ ...row, imdbUserId: "ur99887766" }] },
      });
    }
  });
  await app.open(`/configure?userId=${account}`);
  await screen.getByPlaceholder(sourcePlaceholder).fill("p.fixture");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByPlaceholder(sourcePlaceholder)).toHaveValue(
    "ur99887766",
  );
  await expect(
    screen.getByText(/Saved! Catalog structure changed/),
  ).toBeVisible();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(
      "Saved! Your catalogs will be refreshed with the new settings.",
    ),
  ).toBeVisible();
  expect(requests).toBe(2);
});

test("network save failure preserves values for a retry", async ({
  app,
  browser,
  screen,
}) => {
  let attempts = 0;
  await browser.route(`${backend}/${account}/config`, async (route) => {
    if (route.request.method === "GET")
      await route.fulfill({ json: configuration });
    else if (++attempts === 1) await route.abort();
    else await route.fulfill({ json: { ok: true } });
  });
  await app.open(`/configure?userId=${account}`);
  await screen.getByPlaceholder(titlePlaceholder).fill("Keep my changes");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText("Failed to fetch", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByPlaceholder(titlePlaceholder)).toHaveValue(
    "Keep my changes",
  );
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(/Saved! Catalog structure changed/),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test(
  "a saved genre missing from refreshed choices can still be cleared",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    const submissions = await captureConfig(browser, {
      ...configuration,
      watchlists: [
        {
          ...row,
          availableGenres: [],
          catalogSettings: { genre: "Western", presets: ["rated"] },
        },
      ],
    });
    await app.open(`/configure?userId=${account}`);
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
    await expect(
      screen.getByText(
        "Saved! Your catalogs will be refreshed with the new settings.",
      ),
    ).toBeVisible();
    expect(submissions[0].watchlists[0].catalogSettings).toEqual({
      presets: ["rated"],
    });
  },
);
