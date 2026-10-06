import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";
import { bootstrapLegacy, createAccount, getConfig } from "../helpers/api.js";
import { resetDb, seedAccountWithLists } from "../helpers/db.js";
import {
  PUBLIC_LIST,
  PUBLIC_USER,
  UNKNOWN_USER,
} from "../helpers/test-data.js";

// The /configure page against the real backend: List management, options,
// refresh, install links.

const configureUrl = (accountKey: string) =>
  `${FRONTEND_URL}/configure?account=${accountKey}`;

/** A private Account with one IMDb watchlist List titled "My watchlist". */
async function seedAccount() {
  const {
    accountId,
    listIds: [listId],
  } = await seedAccountWithLists([
    {
      sourceRef: PUBLIC_USER,
      catalogTitle: "My watchlist",
      displayMode: "split",
    },
  ]);
  return { accountId, listId };
}

async function open(page: Page, accountKey: string) {
  await page.goto(configureUrl(accountKey));
  await expect(page.getByText("My watchlist", { exact: true })).toBeVisible();
}

async function save(page: Page) {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText("Saved!", { exact: false })).toBeVisible();
}

test.beforeEach(async () => {
  await resetDb();
});

test(
  "loads the existing configuration",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    await open(page, accountId);

    await expect(
      page.getByText(`IMDb · Watchlist · ${PUBLIC_USER}`),
    ).toBeVisible();
    await expect(page.getByText("1 of 10 lists")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Stremio Web" }),
    ).toBeVisible();
    await expect(page.getByLabel("Addon URL", { exact: true })).toHaveValue(
      `${BACKEND_URL}/${accountId}/manifest.json`,
    );
  },
);

test(
  "Addon URL copy works through an accessible control",
  { tag: "@local" },
  async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: FRONTEND_URL,
    });
    const { accountId } = await seedAccount();
    await open(page, accountId);
    const copyButton = page.getByRole("button", { name: "Copy Addon URL" });
    await expect(copyButton).toBeVisible();

    await copyButton.click();
    await expect(
      page.getByRole("button", { name: "Addon URL copied" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${BACKEND_URL}/${accountId}/manifest.json`);
  },
);

test(
  "clipboard denial explains how to copy the Addon URL manually",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    await open(page, accountId);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () =>
          Promise.reject(new DOMException("Denied", "NotAllowedError")),
      });
    });

    await page.getByRole("button", { name: "Copy Addon URL" }).click();
    await expect(
      page.getByText(
        "Could not copy the Addon URL. Select it and copy it manually.",
      ),
    ).toBeVisible({ timeout: 2_000 });
  },
);

test(
  "failed configuration loads cannot overwrite saved settings and can retry",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    // Development builds run the load effect twice, so fail every load until
    // the error is on screen.
    let failing = true;
    await page.route(`**/${accountId}/config`, async (route) => {
      if (route.request().method() === "GET" && failing) {
        await route.fulfill({
          status: 503,
          json: { error: "Configuration storage unavailable." },
        });
        return;
      }
      await route.continue();
    });

    await page.goto(configureUrl(accountId));
    await expect(
      page.getByText("Could not load your configuration. Please try again."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).not.toBeVisible();

    failing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("My watchlist", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
  },
);

test(
  "adds an IMDb list from a pasted link and saves",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    await open(page, accountId);

    await page
      .getByLabel("Paste a link to a watchlist or list")
      .fill(`https://www.imdb.com/list/${PUBLIC_LIST}/`);
    await expect(page.getByText("IMDb list detected")).toBeVisible();
    const resolved = page.waitForResponse((res) =>
      res.url().endsWith("/links/resolve"),
    );
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(await (await resolved).json()).toMatchObject({
      ok: true,
      provider: "imdb",
      sourceRef: PUBLIC_LIST,
    });
    await expect(page.getByText(`IMDb · List · ${PUBLIC_LIST}`)).toBeVisible();
    await expect(page.getByText("2 of 10 lists")).toBeVisible();

    await save(page);
    const { body } = await getConfig(accountId);
    expect(body.lists.map((list) => list.sourceRef)).toEqual([
      PUBLIC_USER,
      PUBLIC_LIST,
    ]);
  },
);

test(
  "the first List of an Account saved without Lists asks for a reinstall",
  { tag: "@local" },
  async ({ page }) => {
    // Simkl and MDBList users create the Account first, to connect.
    const { body } = await createAccount([]);
    const accountId = body.accountId!;
    await page.goto(configureUrl(accountId));
    await expect(page.getByText("No Lists yet")).toBeVisible();
    await page.getByRole("button", { name: "Add an IMDb chart" }).click();
    await page
      .getByRole("menuitem", { name: /^Box Office \(Weekend\)/ })
      .click();
    await save(page);
    await expect(
      page.getByText(
        "Saved! Reinstall Stremlist in Stremio to see your new catalogs and Actions.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Reinstall in Stremio to see your changes",
      }),
    ).toBeVisible();
    expect((await getConfig(accountId)).body.lists).toMatchObject([
      { provider: "imdb", sourceRef: "imdb:box-office" },
    ]);
  },
);

test("adds a built-in chart List", { tag: "@local" }, async ({ page }) => {
  const { accountId } = await seedAccount();
  await open(page, accountId);

  await page.getByRole("button", { name: "Add an IMDb chart" }).click();
  await page.getByRole("menuitem", { name: /^Top 250 Movies/ }).click();
  await expect(page.getByText("IMDb · Chart")).toBeVisible();

  await save(page);
  const { body } = await getConfig(accountId);
  expect(body.lists[1]).toMatchObject({
    provider: "imdb",
    sourceRef: "imdb:top-rated-movies",
    catalogTitle: "Top 250 Movies",
    displayMode: "movie",
  });
});

test(
  "changes sort order and content filter",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    await open(page, accountId);

    await page.getByRole("combobox", { name: "Sort order" }).click();
    await page
      .getByRole("option", { name: "IMDb Rating (Highest First)" })
      .click();
    await page
      .getByRole("button", { name: "Settings for My watchlist" })
      .click();
    await page.getByRole("combobox", { name: "Show", exact: true }).click();
    await page.getByRole("option", { name: "Movies only" }).click();
    await save(page);

    const { body } = await getConfig(accountId);
    expect(body.lists[0].sortOption).toBe("rating-desc");
    expect(body.lists[0].displayMode).toBe("movie");
  },
);

test("saves and clears the RPDB key", { tag: "@local" }, async ({ page }) => {
  const { accountId } = await seedAccount();
  await open(page, accountId);

  await page.locator("#rpdb-api-key").fill("e2e-rpdb-key");
  await save(page);
  expect((await getConfig(accountId)).body.rpdbApiKey).toBe("e2e-rpdb-key");

  await page.locator("#rpdb-api-key").fill("");
  await save(page);
  expect((await getConfig(accountId)).body.rpdbApiKey).toBeNull();
});

test("removes a List", { tag: "@local" }, async ({ page }) => {
  const { accountId } = await seedAccount();
  await open(page, accountId);
  await page.getByRole("button", { name: "Add an IMDb chart" }).click();
  await page.getByRole("menuitem", { name: /^Box Office \(Weekend\)/ }).click();
  await expect(page.getByText("2 of 10 lists")).toBeVisible();

  await page
    .getByRole("button", { name: "Remove Box Office (Weekend)" })
    .click();
  await expect(page.getByText("1 of 10 lists")).toBeVisible();

  await save(page);
  expect((await getConfig(accountId)).body.lists).toHaveLength(1);
});

test(
  "manual refresh hits the backend and starts the cooldown",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    await open(page, accountId);

    const refreshResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/refresh") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /Refresh now|Refresh in/ }).click();
    expect((await refreshResponse).status()).toBe(200);
    await expect(
      page.getByRole("button", { name: /Refresh in \d+s/ }),
    ).toBeDisabled();
  },
);

test(
  "unknown Addon URLs are told to build a new Stremlist",
  { tag: "@local" },
  async ({ page }) => {
    for (const key of ["sl_0000000000000000000000", UNKNOWN_USER]) {
      await page.goto(configureUrl(key));
      await expect(
        page.getByText("We could not find this Stremlist"),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Build a new Stremlist" }),
      ).toHaveAttribute("href", "/configure");
    }
  },
);

test(
  "pasting an Addon URL on Home loads its configuration",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedAccount();
    await bootstrapLegacy(PUBLIC_USER);
    for (const key of [accountId, PUBLIC_USER]) {
      await page.goto(FRONTEND_URL);
      await page.getByRole("button", { name: "I already have one" }).click();
      await page
        .getByLabel("Your Addon URL")
        .fill(`stremio://127.0.0.1:7301/${key}/manifest.json`);
      await page.getByRole("button", { name: "Open", exact: true }).click();
      await expect(page).toHaveURL(configureUrl(key));
      await expect(
        page.getByText(`IMDb · Watchlist · ${PUBLIC_USER}`),
      ).toBeVisible();
    }
    // The Legacy alias install offers its private Addon URL upgrade.
    await expect(
      page.getByRole("heading", { name: "Upgrade to a private URL" }),
    ).toBeVisible();
  },
);
