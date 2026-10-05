import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const userId = "ur99123456";
const watchlist = {
  id: "test-watchlist",
  imdbUserId: userId,
  catalogTitle: "Test catalog",
  sortOption: "added_at-asc",
  displayMode: "split",
  position: 0,
};
const config = {
  rpdbApiKey: "",
  lastFetchedAt: null,
  cooldownSeconds: 2,
  watchlists: [watchlist],
};

async function fixture(
  browser: Browser,
  options: {
    existing?: boolean;
    valid?: boolean;
    private?: boolean;
    unavailable?: boolean;
  } = {},
) {
  await browser.route("http://127.0.0.1:4314/**", async (route) => {
    if (options.unavailable) {
      await route.abort();
      return;
    }
    const path = new URL(route.request.url).pathname;
    if (path.startsWith("/validate/")) {
      await route.fulfill({
        json: {
          valid: options.valid ?? true,
          userId,
          reason: options.private ? "private" : "not_found",
        },
      });
    } else if (path.endsWith("/config")) {
      await route.fulfill({
        status: options.existing ? 200 : 404,
        json: options.existing ? config : { error: "not found" },
      });
    } else {
      await route.fulfill({
        status: 404,
        json: { error: "Unmatched fixture" },
      });
    }
  });
}

test("public pages and unknown routes provide navigation", async ({
  app,
  screen,
  browser,
}) => {
  for (const [path, heading] of [
    ["/", "Connect IMDb to Stremio"],
    ["/terms", /Terms/],
    ["/changelog", /Changelog/],
    ["/unknown", "Page not found"],
  ] as const) {
    await app.open(path);
    await expect(screen.getByRole("heading", heading).first()).toBeVisible();
  }
  await screen.getByRole("link", "Return to home").tap();
  await expect(browser).toHaveURL("/");
});

test("format errors and clearing input remove install actions", async ({
  app,
  screen,
  browser,
}) => {
  await fixture(browser);
  await app.open("/");
  await screen.getByLabel("IMDb User ID:").fill("banana");
  await expect(
    screen.getByText(/Could not find a valid IMDb ID/),
  ).toBeVisible();
  await screen.getByLabel("IMDb User ID:").fill(userId);
  await expect(screen.getByRole("link", "Open in Stremio Web")).toBeVisible();
  await screen.getByLabel("IMDb User ID:").fill("");
  await expect(
    screen.getByRole("link", "Open in Stremio Web"),
  ).not.toBeVisible();
  await expect(browser).toHaveURL("/");
});

test("profile URLs resolve to canonical install URLs", async ({
  app,
  screen,
  browser,
}) => {
  await fixture(browser);
  await app.open("/");
  await screen
    .getByLabel("IMDb User ID:")
    .fill("https://www.imdb.com/user/p.example/");
  await expect(
    screen.getByRole("link", "Open in Stremio Desktop"),
  ).toHaveAttribute("href", `stremio://127.0.0.1:4314/${userId}/manifest.json`);
  await expect(screen.getByRole("link", "Open in Stremio Web")).toHaveAttribute(
    "href",
    `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`http://127.0.0.1:4314/${userId}/manifest.json`)}`,
  );
  await expect(browser).toHaveURL(`/?userId=${userId}`);
  await expect(screen.getByText(/maps to the canonical ID/)).toBeVisible();
});

for (const state of ["private", "unknown", "offline"] as const) {
  test(`validation reports ${state} watchlists`, async ({
    app,
    screen,
    browser,
  }) => {
    await fixture(browser, {
      valid: false,
      private: state === "private",
      unavailable: state === "offline",
    });
    await app.open("/");
    await screen.getByLabel("IMDb User ID:").fill(userId);
    await expect(
      screen.getByText(
        state === "private"
          ? /This IMDb watchlist is private/
          : state === "unknown"
            ? /This IMDb ID does not exist/
            : /Could not validate this IMDb ID/,
      ),
    ).toBeVisible();
    await expect(
      screen.getByRole("link", "Open in Stremio Web"),
    ).not.toBeVisible();
  });
}

test("returning users can open configuration", async ({
  app,
  screen,
  browser,
}) => {
  await fixture(browser, { existing: true });
  await app.open(`/?userId=${userId}`);
  await expect(screen.getByText(`Welcome back, ${userId}!`)).toBeVisible();
  await screen.getByRole("link", "Configure your Stremlist").tap();
  await expect(browser).toHaveURL(`/configure?userId=${userId}`);
  await expect(screen.getByText("Catalog 1")).toBeVisible();
});

test("configuration handles missing users and load retry", async ({
  app,
  screen,
  browser,
}) => {
  let unavailable = true;
  await browser.route("http://127.0.0.1:4314/**", async (route) => {
    await route.fulfill({
      status: unavailable ? 503 : 404,
      json: { error: "test" },
    });
  });
  await app.open(`/configure?userId=${userId}`);
  await expect(
    screen.getByText("Could not load your configuration. Please try again."),
  ).toBeVisible();
  unavailable = false;
  await screen.getByRole("button", "Try again").tap();
  await expect(screen.getByText(/User not found/)).toBeVisible();
  await expect(screen.getByRole("button", "Save")).not.toBeVisible();
});

test("catalog edits validate duplicates, save values and refresh failures", async ({
  app,
  screen,
  browser,
}) => {
  let saved: Record<string, unknown> | undefined;
  await browser.route("http://127.0.0.1:4314/**", async (route) => {
    if (
      route.request.method === "POST" &&
      route.request.url.endsWith("/config")
    ) {
      saved = JSON.parse(route.request.postData ?? "{}");
      await route.fulfill({
        json: {
          ok: true,
          watchlists: (
            saved as { watchlists: Record<string, unknown>[] }
          ).watchlists.map((row, index) => ({ ...row, id: `saved-${index}` })),
        },
      });
    } else if (route.request.url.endsWith("/refresh")) {
      await route.fulfill({
        json: { ok: true, failed: 1, refreshed: 0, total: 1 },
      });
    } else {
      await route.fulfill({ json: config });
    }
  });
  await app.open(`/configure?userId=${userId}`);
  await expect(screen.getByText("Catalog 1")).toBeVisible();
  await screen.getByRole("button", "Add Catalog", { exact: true }).tap();
  const sources = screen.getByPlaceholder(
    "ur12345678, p.colneedham, or ls593621567",
  );
  await sources.nth(1).fill(userId);
  await expect(
    screen.getByText("IMDb IDs must be unique across catalogs."),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Save", { exact: true }),
  ).toBeDisabled();
  await sources.nth(1).fill("ls99123456");
  await screen
    .getByPlaceholder("Tom Hardy's Watchlist")
    .nth(1)
    .fill("My movies");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(/Saved! Catalog structure changed/),
  ).toBeVisible();
  expect(saved).toMatchObject({
    watchlists: [
      { imdbUserId: userId, position: 0 },
      { imdbUserId: "ls99123456", catalogTitle: "My movies", position: 1 },
    ],
  });
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(
      "Saved! Your catalogs will be refreshed with the new settings.",
    ),
  ).toBeVisible();
  await screen.getByRole("button", "Remove catalog").nth(1).tap();
  await expect(screen.getByRole("button", "Remove catalog")).toHaveCount(1);
  await expect(screen.getByRole("button", "Remove catalog")).toBeDisabled();
  await screen.getByRole("button", "Refresh now").tap();
  await expect(screen.getByText(/some failed to update/)).toBeVisible();
});

for (const result of ["success", "server-error", "offline"] as const) {
  test(`newsletter validates email and handles ${result}`, async ({
    app,
    screen,
    browser,
  }) => {
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
    await screen.getByPlaceholder("your@email.com").fill("e2e@example.test");
    await screen.getByRole("button", "Subscribe", { exact: true }).tap();
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
  });
}

for (const entry of ["typed", "query"] as const) {
  test(`onboarding ${entry} entry rejects a failed configuration lookup`, async ({
    app,
    screen,
    browser,
  }) => {
    let configRequests = 0;
    let validationRequests = 0;
    await browser.route("http://127.0.0.1:4314/**", async (route) => {
      const path = new URL(route.request.url).pathname;
      if (path === "/stats") {
        await route.fulfill({ json: { users: 0, watchlists: 0 } });
      } else if (path === `/validate/${userId}`) {
        validationRequests += 1;
        await route.fulfill({ json: { valid: true, userId } });
      } else if (
        path === `/${userId}/config` &&
        route.request.method === "GET"
      ) {
        configRequests += 1;
        await route.fulfill({ status: 503, json: { error: "Unavailable" } });
      } else {
        throw new Error(
          `Unexpected test API request: ${route.request.method} ${path}`,
        );
      }
    });
    await app.open(entry === "query" ? `/?userId=${userId}` : "/");
    if (entry === "typed")
      await screen.getByLabel("IMDb User ID:").fill(userId);
    await expect(
      screen.getByText(
        "Could not validate this IMDb ID. Please try again later.",
      ),
    ).toBeVisible();
    expect(configRequests).toBeGreaterThan(0);
    // Config is checked first. A service failure must stop onboarding before
    // validation can offer a fresh installation for an existing account.
    expect(validationRequests).toBe(0);
    await expect(
      screen.getByRole("link", "Configure your Stremlist"),
    ).not.toBeVisible();
    await expect(
      screen.getByRole("link", "Open in Stremio Web"),
    ).not.toBeVisible();
    await expect(
      screen.getByRole("link", "Open in Stremio Desktop"),
    ).not.toBeVisible();
    await expect(
      screen.getByText(`Welcome back, ${userId}!`),
    ).not.toBeVisible();
    await expect(browser).toHaveURL(
      entry === "query" ? `/?userId=${userId}` : "/",
    );
  });
}

test("built-in catalogs avoid duplicates and enforce the catalog limit", async ({
  app,
  screen,
  browser,
}) => {
  await fixture(browser, { existing: true });
  await app.open(`/configure?userId=${userId}`);
  await screen.getByRole("button", "Add Built-in Catalog").tap();
  await screen.getByRole("menuitem", /Top 250 Movies/).tap();
  await expect(screen.getByText("Catalog 2")).toBeVisible();
  await screen.getByRole("button", "Add Built-in Catalog").tap();
  await expect(screen.getByRole("menuitem", /Top 250 Movies/)).toBeDisabled();
  await browser.keyboard.press("Escape");
  for (let i = 2; i < 10; i += 1)
    await screen.getByRole("button", "Add Catalog", { exact: true }).tap();
  await expect(
    screen.getByRole("button", "Add Catalog", { exact: true }),
  ).toBeDisabled();
  await expect(
    screen.getByRole("button", "Add Built-in Catalog"),
  ).toBeDisabled();
  await expect(screen.getByRole("button", "Remove catalog")).toHaveCount(10);
});

test("save errors preserve changes and allow a successful retry", async ({
  app,
  screen,
  browser,
}) => {
  let rejected = true;
  await browser.route("http://127.0.0.1:4314/**", async (route) => {
    if (route.request.method === "POST") {
      await route.fulfill({
        status: rejected ? 400 : 200,
        json: rejected ? { error: "Test save rejected" } : { ok: true },
      });
    } else await route.fulfill({ json: config });
  });
  await app.open(`/configure?userId=${userId}`);
  await screen
    .getByPlaceholder("Tom Hardy's Watchlist")
    .fill("Updated catalog");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText("Test save rejected")).toBeVisible();
  await expect(screen.getByPlaceholder("Tom Hardy's Watchlist")).toHaveValue(
    "Updated catalog",
  );
  rejected = false;
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(/Saved! Catalog structure changed/),
  ).toBeVisible();
});

test("successful refresh applies cooldown and blocks another refresh", async ({
  app,
  screen,
  browser,
}) => {
  let refreshes = 0;
  await browser.route("http://127.0.0.1:4314/**", async (route) => {
    if (route.request.url.endsWith("/refresh")) {
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
    } else await route.fulfill({ json: config });
  });
  await app.open(`/configure?userId=${userId}`);
  await screen.getByRole("button", "Refresh now").tap();
  await expect(screen.getByRole("button", /Refresh in \d+s/)).toBeDisabled();
  expect(refreshes).toBe(1);
});

test("RPDB key visibility control hides the key again", async ({
  app,
  screen,
  browser,
}) => {
  await fixture(browser, { existing: true });
  await app.open(`/configure?userId=${userId}`);
  await expect(screen.getByRole("button", "Show RPDB API key")).toBeVisible();
  await screen.getByRole("button", "Show RPDB API key").tap();
  await expect(screen.getByLabel("RPDB API Key (Optional)")).toHaveAttribute(
    "type",
    "text",
  );
  await screen.getByRole("button", "Hide RPDB API key").tap();
  await expect(screen.getByRole("button", "Show RPDB API key")).toBeVisible();
});

test("clipboard denial offers manual manifest copy", async ({
  app,
  screen,
  browser,
}) => {
  await fixture(browser, { existing: true });
  await browser.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () =>
        Promise.reject(new DOMException("Denied", "NotAllowedError")),
    });
  });
  await app.open(`/configure?userId=${userId}`);
  await screen.getByRole("button", "Copy manifest URL").tap();
  await expect(
    screen.getByText(
      "Could not copy the manifest URL. Select it and copy it manually.",
    ),
  ).toBeVisible();
});

test("pointer reorder changes visible catalog order and saved positions", async ({
  app,
  screen,
  browser,
}) => {
  let saved:
    | {
        watchlists: Array<{
          imdbUserId: string;
          catalogTitle: string;
          position: number;
        }>;
      }
    | undefined;
  const second = {
    ...watchlist,
    id: "second-watchlist",
    imdbUserId: "ls99123456",
    catalogTitle: "Second catalog",
    position: 1,
  };
  await browser.route("http://127.0.0.1:4314/**", async (route) => {
    if (route.request.method === "POST") {
      saved = JSON.parse(route.request.postData ?? "{}");
      await route.fulfill({ json: { ok: true } });
    } else
      await route.fulfill({
        json: { ...config, watchlists: [watchlist, second] },
      });
  });
  await app.open(`/configure?userId=${userId}`);
  await expect(screen.getByRole("button", "Drag to reorder")).toHaveCount(2);
  await screen
    .getByRole("button", "Drag to reorder")
    .nth(1)
    .dragTo(screen.getByRole("button", "Drag to reorder").first());
  await expect(
    screen.getByPlaceholder("Tom Hardy's Watchlist").first(),
  ).toHaveValue("Second catalog");
  await expect(
    screen.getByPlaceholder("Tom Hardy's Watchlist").nth(1),
  ).toHaveValue("Test catalog");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(
    screen.getByText(/Saved! Catalog structure changed/),
  ).toBeVisible();
  expect(saved?.watchlists).toMatchObject([
    { imdbUserId: "ls99123456", catalogTitle: "Second catalog", position: 0 },
    { imdbUserId: userId, catalogTitle: "Test catalog", position: 1 },
  ]);
});
