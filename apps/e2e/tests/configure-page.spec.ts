import { expect, test } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";
import { bootstrapLegacy, createAccount, getConfig } from "../helpers/api.js";
import { resetDb, seedImdbAccount } from "../helpers/db.js";
import {
  PUBLIC_LIST,
  PUBLIC_USER,
  UNKNOWN_USER,
} from "../helpers/test-data.js";
import {
  configureUrl,
  openConfigure,
  saveButton,
  saveConfigure,
  SAVED_REINSTALL,
} from "../helpers/configure.js";

// The /configure page against the real backend: List management, options,
// refresh, install links.

/** The title of the IMDb watchlist List that `seedWatchlist` seeds. */
const TITLE = "My watchlist";

/** A private Account with one IMDb watchlist List titled "My watchlist". */
const seedWatchlist = () => seedImdbAccount(PUBLIC_USER, TITLE);

test.beforeEach(async () => {
  await resetDb();
});

test(
  "loads the existing configuration",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);

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
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);
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
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);
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
    const { accountId } = await seedWatchlist();
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
    await expect(saveButton(page)).not.toBeVisible();

    failing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("My watchlist", { exact: true })).toBeVisible();
    await expect(saveButton(page)).toBeVisible();
  },
);

test(
  "adds an IMDb list from a pasted link and saves",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);

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

    await saveConfigure(page);
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
    await saveConfigure(page);
    await expect(page.getByText(SAVED_REINSTALL)).toBeVisible();
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
  const { accountId } = await seedWatchlist();
  await openConfigure(page, accountId, TITLE);

  await page.getByRole("button", { name: "Add an IMDb chart" }).click();
  await page.getByRole("menuitem", { name: /^Top 250 Movies/ }).click();
  await expect(page.getByText("IMDb · Chart")).toBeVisible();

  await saveConfigure(page);
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
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);

    await page.getByRole("combobox", { name: "Sort order" }).click();
    await page
      .getByRole("option", { name: "IMDb Rating (Highest First)" })
      .click();
    await page
      .getByRole("button", { name: "Settings for My watchlist" })
      .click();
    await page.getByRole("combobox", { name: "Show", exact: true }).click();
    await page.getByRole("option", { name: "Movies only" }).click();
    await saveConfigure(page);

    const { body } = await getConfig(accountId);
    expect(body.lists[0].sortOption).toBe("rating-desc");
    expect(body.lists[0].displayMode).toBe("movie");
  },
);

test("saves and clears the RPDB key", { tag: "@local" }, async ({ page }) => {
  const { accountId } = await seedWatchlist();
  await openConfigure(page, accountId, TITLE);

  await page.locator("#rpdb-api-key").fill("e2e-rpdb-key");
  await saveConfigure(page);
  expect((await getConfig(accountId)).body.rpdbApiKey).toBe("e2e-rpdb-key");

  await page.locator("#rpdb-api-key").fill("");
  await saveConfigure(page);
  expect((await getConfig(accountId)).body.rpdbApiKey).toBeNull();
});

test("removes a List", { tag: "@local" }, async ({ page }) => {
  const { accountId } = await seedWatchlist();
  await openConfigure(page, accountId, TITLE);
  await page.getByRole("button", { name: "Add an IMDb chart" }).click();
  await page.getByRole("menuitem", { name: /^Box Office \(Weekend\)/ }).click();
  await expect(page.getByText("2 of 10 lists")).toBeVisible();

  await page
    .getByRole("button", { name: "Remove Box Office (Weekend)" })
    .click();
  await expect(page.getByText("1 of 10 lists")).toBeVisible();

  await saveConfigure(page);
  expect((await getConfig(accountId)).body.lists).toHaveLength(1);
});

test(
  "manual refresh hits the backend and starts the cooldown",
  { tag: "@live-regression" },
  async ({ page }) => {
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);

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
    const { accountId } = await seedWatchlist();
    await bootstrapLegacy(PUBLIC_USER);
    for (const key of [accountId, PUBLIC_USER]) {
      await page.goto(FRONTEND_URL);
      await page.getByRole("button", { name: "Open it" }).click();
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

/** The Addon URL of an Account on Stremio Web, as the install links build it. */
const stremioWebUrl = (accountKey: string) =>
  `https://web.stremio.com/#/addons?addon=${encodeURIComponent(
    `${BACKEND_URL}/${accountKey}/manifest.json`,
  )}`;

test(
  "a catalog change asks for a reinstall until it is done, a sort change does not",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);
    const beforeSave = page.getByText("These changes need a reinstall.");
    const reminder = page
      .getByRole("status")
      .filter({ hasText: "Reinstall Stremlist in Stremio" });

    // Sort order and posters apply without a reinstall: no hint, no reminder.
    await page.getByRole("combobox", { name: "Sort order" }).click();
    await page
      .getByRole("option", { name: "IMDb Rating (Highest First)" })
      .click();
    await page.locator("#rpdb-api-key").fill("e2e-rpdb-key");
    await expect(beforeSave).toHaveCount(0);
    await saveConfigure(page);
    await expect(
      page.getByText(
        "Saved! Your catalogs will refresh with the new settings.",
      ),
    ).toBeVisible();
    await expect(reminder).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Install or reinstall in Stremio" }),
    ).toBeVisible();

    // A new catalog title changes what Stremio read at install time.
    await page
      .getByRole("button", { name: "Settings for My watchlist" })
      .click();
    await page.getByLabel("Catalog title").fill("Renamed watchlist");
    await expect(beforeSave).toBeVisible();
    await saveConfigure(page);
    await expect(page.getByText(SAVED_REINSTALL)).toBeVisible();
    await expect(beforeSave).toHaveCount(0);
    await expect(reminder).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Reinstall in Stremio to see your changes",
      }),
    ).toBeVisible();
    // A local Addon URL has no `stremio://` link, so Reinstall opens Stremio Web.
    await expect(
      reminder.getByRole("link", { name: "Reinstall" }),
    ).toHaveAttribute("href", stremioWebUrl(accountId));

    // The reminder stays until the user reinstalls, also after a reload and
    // after a save that changes nothing.
    await page.reload();
    await expect(reminder).toBeVisible();
    await saveConfigure(page);
    await expect(page.getByText(SAVED_REINSTALL)).toBeVisible();
    await expect(reminder).toBeVisible();

    await reminder.getByRole("button", { name: "I did it" }).click();
    await expect(reminder).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Install or reinstall in Stremio" }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("Renamed watchlist")).toBeVisible();
    await expect(reminder).toHaveCount(0);
    await saveConfigure(page);
    await expect(
      page.getByText(
        "Saved! Your catalogs will refresh with the new settings.",
      ),
    ).toBeVisible();
    const { body } = await getConfig(accountId);
    expect(body.rpdbApiKey).toBe("e2e-rpdb-key");
    expect(body.lists[0]).toMatchObject({
      catalogTitle: "Renamed watchlist",
      sortOption: "rating-desc",
    });
  },
);

test(
  "the Reinstall action of the save toast opens Stremio Web and ends the reminder",
  { tag: "@local" },
  async ({ page, context }) => {
    // Stremio Web is not under test here: answer it with an empty page.
    await context.route("https://web.stremio.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Stremio</title>",
      }),
    );
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);
    await page.getByRole("button", { name: "Add an IMDb chart" }).click();
    await page.getByRole("menuitem", { name: /^Top 250 Movies/ }).click();
    await saveConfigure(page);

    const toast = page
      .getByRole("listitem")
      .filter({ hasText: SAVED_REINSTALL });
    const reminder = page
      .getByRole("status")
      .filter({ hasText: "Reinstall Stremlist in Stremio" });
    await expect(reminder).toBeVisible();
    const popup = context.waitForEvent("page");
    await toast.getByRole("button", { name: "Reinstall" }).click();
    const stremioWeb = await popup;
    await stremioWeb.waitForLoadState();
    expect(stremioWeb.url()).toBe(stremioWebUrl(accountId));
    await stremioWeb.close();
    await expect(reminder).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("2 of 10 lists")).toBeVisible();
    await expect(reminder).toHaveCount(0);
  },
);

test(
  "the floating Save button shows once the header Save scrolls away",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedWatchlist();
    await openConfigure(page, accountId, TITLE);
    const saves = page.getByRole("button", { name: "Save", exact: true });
    const headerSave = saves.first();
    const floatingSave = saves.last();
    const floatingBar = floatingSave.locator("xpath=..");
    await expect(saves).toHaveCount(2);
    await expect(headerSave).toBeInViewport();
    // Hidden while the header Save is in view: inert and transparent.
    await expect(floatingBar).toHaveAttribute("inert", "");

    // An edit at the end of the page, then Save from there.
    await page.locator("#rpdb-api-key").fill("floating-save-key");
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await expect(headerSave).not.toBeInViewport();
    await expect(floatingBar).not.toHaveAttribute("inert");
    await expect(floatingSave).toBeInViewport();
    await expect(floatingSave).toBeEnabled();
    await saveConfigure(page, {
      button: floatingSave,
      message: "Saved! Your catalogs will refresh with the new settings.",
    });
    expect((await getConfig(accountId)).body.rpdbApiKey).toBe(
      "floating-save-key",
    );

    // Back at the top, the header Save takes over again.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(headerSave).toBeInViewport();
    await expect(floatingBar).toHaveAttribute("inert", "");
  },
);
