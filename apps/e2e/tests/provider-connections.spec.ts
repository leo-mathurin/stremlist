import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";
import { listInput } from "../helpers/api.js";
import {
  configureUrl,
  openConfigure,
  saveConfigure,
} from "../helpers/configure.js";
import {
  getAccountRow,
  getConnectionRow,
  getOAuthStates,
  resetDb,
  seedAccount,
  seedConnection,
  seedList,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { getCacheManifest } from "../helpers/r2.js";
import { LEGACY_CONNECTION_USER } from "../helpers/test-data.js";

// Connections against the real backend, database and R2 store: OAuth start
// and callback, disconnect, expired tokens and the Legacy alias limits. A
// separate backend with helpers/provider-fixtures.ts answers every Provider
// request with deterministic data (dummy client IDs, no real credentials)
// and logs what the backend sent.

let backend: FixtureBackend;

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider-fixtures.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
});

/** The movie Catalog of the List `listId`, from the fixture backend. */
const movieCatalog = async (accountKey: string, listId: string) =>
  (await backend.api.getCatalog(accountKey, "movie", `wl-${listId}-movie`))
    .metas;

test(
  "Trakt OAuth start and callback store an encrypted Connection",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = (await api.createAccount([])).body.accountId!;
    const start = async () => {
      const response = await api.startConnection(accountId, "trakt");
      expect(response.status).toBe(200);
      return new URL(response.body.authorizeUrl);
    };

    const authorize = await start();
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://auth.trakt.tv/oauth/authorize",
    );
    const state = authorize.searchParams.get("state")!;
    const challenge = authorize.searchParams.get("code_challenge")!;
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "fixture-trakt-client",
      redirect_uri: `${backend.url}/oauth/trakt/callback`,
      code_challenge_method: "S256",
    });
    expect(await getOAuthStates(state)).toEqual([{ provider: "trakt" }]);

    const returnWithCode = () =>
      api.oauthCallback("trakt", { code: "fixture-code", state });
    const callback = await returnWithCode();
    expect(callback.status).toBe(302);
    expect(callback.location).toBe(
      `${FRONTEND_URL}/configure?account=${accountId}&connected=trakt`,
    );
    // PKCE: the token request proves the verifier behind the challenge.
    const [exchange] = backend.requests(
      (url) => url.host === "auth.trakt.tv" && url.pathname === "/oauth/token",
    );
    expect(exchange.body).toMatchObject({
      grant_type: "authorization_code",
      code: "fixture-code",
      client_id: "fixture-trakt-client",
      redirect_uri: `${backend.url}/oauth/trakt/callback`,
    });
    expect(
      createHash("sha256")
        .update(String(exchange.body?.code_verifier))
        .digest("base64url"),
    ).toBe(challenge);
    const row = await getConnectionRow(accountId, "trakt");
    expect(row).toMatchObject({
      provider_username: "fixture-user",
      redirect_uri: `${backend.url}/oauth/trakt/callback`,
    });
    expect(row?.access_token).toMatch(/^v1:/);
    expect(row?.access_token).not.toContain("fresh-access");
    const config = await api.getConfig(accountId);
    expect(config.body.connections).toMatchObject([
      { provider: "trakt", username: "fixture-user" },
    ]);

    // A state works once; a refusal and a broken request say why.
    const replay = await returnWithCode();
    expect(replay.location).toBe(
      `${FRONTEND_URL}/configure?connection_error=expired&provider=trakt`,
    );
    const second = (await start()).searchParams.get("state")!;
    const denied = await api.oauthCallback("trakt", {
      error: "access_denied",
      state: second,
    });
    expect(denied.location).toBe(
      `${FRONTEND_URL}/configure?account=${accountId}&connection_error=denied&provider=trakt`,
    );
    const invalid = await api.oauthCallback("trakt");
    expect(invalid.location).toBe(
      `${FRONTEND_URL}/configure?connection_error=invalid_request`,
    );

    // The Connection unlocks private Source lists and the user's own lists.
    expect(
      await api.resolveLink("https://trakt.tv/users/me/watchlist", accountId),
    ).toMatchObject({ ok: true, provider: "trakt", sourceRef: "me/watchlist" });
    const sources = await api.getConnectionSources(accountId, "trakt");
    expect(sources.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "me/watchlist" }),
        expect.objectContaining({
          ref: "me/lists/fixture-list",
          label: "Fixture List",
        }),
      ]),
    );
    expect(
      (
        await api.postConfig(accountId, [
          listInput("trakt", "me/watchlist", { displayMode: "split" }),
        ])
      ).status,
    ).toBe(200);
    const [saved] = (await api.getConfig(accountId)).body.lists;
    expect(await api.listCatalogNames(accountId, saved.id, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
    expect(
      backend
        .requests((url) => url.pathname === "/users/me/watchlist")
        .every((entry) => entry.authorization === "fresh-access"),
    ).toBe(true);
  },
);

test(
  "disconnecting revokes the token and private Lists ask to connect again",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const listId = await seedList(accountId, {
      provider: "trakt",
      sourceRef: "me/watchlist",
      catalogTitle: "Trakt Watchlist",
      position: 0,
      displayMode: "split",
    });
    expect(await api.listCatalogNames(accountId, listId, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);

    expect(await api.disconnect(accountId, "trakt")).toEqual({
      status: 200,
      body: { ok: true },
    });
    const [revoke] = backend.requests(
      (url) => url.pathname === "/oauth/revoke",
    );
    expect(revoke.body).toEqual({
      token: "fixture-access-token",
      client_id: "fixture-trakt-client",
    });
    expect(await getConnectionRow(accountId, "trakt")).toBeNull();
    // Nothing read through the Connection stays stored or served.
    expect(await getCacheManifest(listId)).toMatchObject({ deleted: true });
    expect(await movieCatalog(accountId, listId)).toMatchObject([
      {
        id: "stremlist:unavailable:needs_connection",
        name: "⚠️ This watchlist needs your Trakt account",
        description: "Connect Trakt on the Stremlist configure page.",
      },
    ]);
    const config = await api.getConfig(accountId);
    expect(config.body.connections).toEqual([]);
    expect(config.body.lists).toMatchObject([{ sourceRef: "me/watchlist" }]);
  },
);

test(
  "an expired Connection refreshes, or asks to connect again when refused",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const past = new Date(Date.now() - 60_000);
    const seedWatchlist = (accountId: string) =>
      seedList(accountId, {
        provider: "trakt",
        sourceRef: "me/watchlist",
        catalogTitle: "",
        position: 0,
      });
    const refused = await seedAccount();
    await seedConnection(refused, "trakt", {
      expiresAt: past,
      refreshToken: "rejected-refresh",
    });
    const refusedList = await seedWatchlist(refused);
    expect(await movieCatalog(refused, refusedList)).toMatchObject([
      {
        id: "stremlist:unavailable:needs_connection",
        name: "⚠️ This watchlist needs your Trakt account",
      },
    ]);
    // The refresh used the redirect URI stored with the Connection.
    expect(
      backend
        .requests((url) => url.pathname === "/oauth/token")
        .map((entry) => entry.body),
    ).toEqual([
      expect.objectContaining({
        grant_type: "refresh_token",
        refresh_token: "rejected-refresh",
        redirect_uri: `http://127.0.0.1:7301/oauth/trakt/callback`,
      }),
    ]);

    const renewed = await seedAccount();
    await seedConnection(renewed, "trakt", { expiresAt: past });
    const renewedList = await seedWatchlist(renewed);
    const before = await getConnectionRow(renewed, "trakt");
    expect(await api.listCatalogNames(renewed, renewedList, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
    const after = await getConnectionRow(renewed, "trakt");
    expect(after?.access_token).not.toBe(before?.access_token);
    expect(new Date(after!.expires_at!).getTime()).toBeGreaterThan(Date.now());
  },
);

test(
  "a Legacy alias install never reads through a Connection",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const alias = LEGACY_CONNECTION_USER;
    const accountId = await seedAccount({ legacyImdbUserId: alias });
    await seedConnection(accountId, "trakt");
    const publicList = await seedList(accountId, {
      provider: "trakt",
      sourceRef: "users/fixture-user/watchlist",
      catalogTitle: "Public",
      position: 0,
    });
    const privateList = await seedList(accountId, {
      provider: "trakt",
      sourceRef: "me/watchlist",
      catalogTitle: "Private",
      position: 1,
    });
    const manifest = await api.getManifest(alias);
    expect(manifest.catalogs.map((catalog) => catalog.id)).toEqual([
      `wl-${publicList}-movie`,
    ]);
    expect(
      manifest.resources.some(
        (resource) =>
          typeof resource === "object" && resource.name === "stream",
      ),
    ).toBe(false);
    const config = await api.getConfig(alias);
    expect(config.body).toMatchObject({
      access: "legacy",
      accountId: null,
      connections: [],
    });
    expect(config.body.lists.map((row) => row.id)).toEqual([publicList]);
    expect(await api.listCatalogNames(alias, privateList, "movie")).toEqual([]);
    expect(await api.listCatalogNames(alias, publicList, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
    // The Account ID of a legacy Account is no second way in.
    expect((await api.getConfig(accountId)).status).toBe(404);
    expect(
      (
        await api.postConfig(alias, [
          listInput("trakt", "me/watchlist", { displayMode: "split" }),
        ])
      ).body,
    ).toEqual({
      error:
        "Trakt lists need your private Addon URL. Upgrade this install first.",
    });

    // The upgrade copies the Lists to a private Account, not the Connection.
    const upgraded = await api.upgrade(alias);
    expect(upgraded.status).toBe(200);
    const copy = upgraded.body.accountId as string;
    expect(
      (await api.getConfig(copy)).body.lists.map((row) => row.sourceRef),
    ).toEqual(["users/fixture-user/watchlist", "me/watchlist"]);
    expect(await getConnectionRow(copy, "trakt")).toBeNull();
    expect((await getAccountRow(accountId))?.moved_at).not.toBeNull();
    expect(
      (
        await api.postConfig(alias, [
          listInput("trakt", "users/fixture-user/watchlist", {
            displayMode: "split",
          }),
        ])
      ).status,
    ).toBe(409);
  },
);

test(
  "Simkl and MDBList OAuth round trips store their Connection",
  { tag: "@local" },
  async () => {
    const { api } = backend;
    const accountId = (await api.createAccount([])).body.accountId!;
    for (const [provider, authorizeUrl, clientId] of [
      ["simkl", "https://simkl.com/oauth2/authorize", "fixture-simkl-client"],
      [
        "mdblist",
        "https://mdblist.com/oauth/authorize/",
        "fixture-mdblist-client",
      ],
    ] as const) {
      const { authorizeUrl: authorize, callback } = await backend.authorize(
        accountId,
        provider,
      );
      expect(`${authorize.origin}${authorize.pathname}`).toBe(authorizeUrl);
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        response_type: "code",
        client_id: clientId,
        redirect_uri: `${backend.url}/oauth/${provider}/callback`,
      });
      expect(callback.status).toBe(302);
      expect(callback.location).toBe(
        `${FRONTEND_URL}/configure?account=${accountId}&connected=${provider}`,
      );
      const row = await getConnectionRow(accountId, provider);
      expect(row).toMatchObject({
        provider_username: "fixture-user",
        redirect_uri: `${backend.url}/oauth/${provider}/callback`,
      });
      expect(row?.access_token).toMatch(/^v1:/);
    }
    const config = await api.getConfig(accountId);
    expect(
      config.body.connections.map((connection) => connection.provider).sort(),
    ).toEqual(["mdblist", "simkl"]);
    // Both token exchanges sent the one-time code.
    expect(
      backend
        .requests((url) => /\/oauth2?\/token\/?$/.test(url.pathname))
        .map((entry) => entry.body?.code),
    ).toEqual(["fixture-code", "fixture-code"]);
  },
);

// The configure page against the fixture backend: the page's API requests go
// to it, and the Provider's authorize page is a fixture. The test comes back
// to the real OAuth callback, which sends the browser back to the page.

const DRAFT_RESTORED = "Your unsaved changes are back. Save to apply them.";
const TRAKT_LIST = "users/fixture-user/watchlist";

/** Send every request of the page to the backend at `url`. */
async function routePageTo(page: Page, url: string) {
  await page.route(`${BACKEND_URL}/**`, async (route) => {
    const target = new URL(route.request().url());
    const response = await route.fetch({
      url: `${url}${target.pathname}${target.search}`,
    });
    await route.fulfill({ response });
  });
}

/**
 * Click Connect for `label` in the Providers panel. The fixture authorize
 * page opens; the returned function comes back to the OAuth callback of
 * `callbackOrigin` with the fixture code, as when the user agrees.
 */
async function connectFromPage(
  page: Page,
  label: string,
  authorizeHost: string,
) {
  const authorize = page.waitForRequest(
    (request) => new URL(request.url()).host === authorizeHost,
  );
  await page.route(`https://${authorizeHost}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Authorize</title><h1>${label} authorization fixture</h1>`,
    }),
  );
  await page
    .getByRole("listitem")
    .filter({ hasText: label })
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const authorizeUrl = new URL((await authorize).url());
  await expect(
    page.getByRole("heading", { name: `${label} authorization fixture` }),
  ).toBeVisible();
  return async (callbackOrigin: string) => {
    const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
    const callback = new URL(`${callbackOrigin}${redirect.pathname}`);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set(
      "state",
      authorizeUrl.searchParams.get("state") ?? "",
    );
    await page.goto(callback.toString());
  };
}

/** A private Account with one public Trakt List. */
async function seedTraktAccount() {
  const accountId = await seedAccount();
  await seedList(accountId, {
    provider: "trakt",
    sourceRef: TRAKT_LIST,
    catalogTitle: "Fixture watchlist",
    position: 0,
    displayMode: "split",
  });
  return accountId;
}

test(
  "unsaved edits come back after the Connect round trip and save",
  { tag: "@local" },
  async ({ page }) => {
    const { api } = backend;
    const accountId = await seedTraktAccount();
    await routePageTo(page, backend.url);
    await openConfigure(page, accountId, "Fixture watchlist");

    await page
      .getByRole("button", { name: "Settings for Fixture watchlist" })
      .click();
    await page
      .getByLabel("Catalog title", { exact: true })
      .fill("Renamed before connecting");
    await page.locator("#rpdb-api-key").fill("draft-rpdb-key");

    const comeBack = await connectFromPage(page, "Trakt", "auth.trakt.tv");
    await comeBack(backend.url);
    await expect(page).toHaveURL(configureUrl(accountId));
    await expect(
      page.getByText("Trakt is connected. You can now add its lists."),
    ).toBeVisible();
    await expect(page.getByText(DRAFT_RESTORED)).toBeVisible();
    await expect(page.locator("#rpdb-api-key")).toHaveValue("draft-rpdb-key");
    await page
      .getByRole("button", { name: "Settings for Renamed before connecting" })
      .click();
    await expect(page.getByLabel("Catalog title", { exact: true })).toHaveValue(
      "Renamed before connecting",
    );
    // Nothing is saved until the user saves.
    expect(await getConnectionRow(accountId, "trakt")).toMatchObject({
      provider_username: "fixture-user",
    });
    const before = (await api.getConfig(accountId)).body;
    expect(before.lists).toMatchObject([
      { sourceRef: TRAKT_LIST, catalogTitle: "Fixture watchlist" },
    ]);
    expect(before.rpdbApiKey ?? "").toBe("");

    await saveConfigure(page);
    const after = (await api.getConfig(accountId)).body;
    expect(after.lists).toMatchObject([
      { sourceRef: TRAKT_LIST, catalogTitle: "Renamed before connecting" },
    ]);
    expect(after.rpdbApiKey).toBe("draft-rpdb-key");
    expect(after.connections).toMatchObject([
      { provider: "trakt", username: "fixture-user" },
    ]);

    // The kept edits are used once: a reload shows the saved setup only.
    await page.reload();
    await expect(page.getByText("Renamed before connecting")).toBeVisible();
    await expect(page.locator("#rpdb-api-key")).toHaveValue("draft-rpdb-key");
    await expect(page.getByText(DRAFT_RESTORED)).toHaveCount(0);
  },
);

test(
  "the Connect round trip without unsaved edits brings back no draft",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedTraktAccount();
    await routePageTo(page, backend.url);
    await openConfigure(page, accountId, "Fixture watchlist");

    const comeBack = await connectFromPage(page, "Simkl", "simkl.com");
    await comeBack(backend.url);
    await expect(page).toHaveURL(configureUrl(accountId));
    await expect(
      page.getByText("Simkl is connected. You can now add its lists."),
    ).toBeVisible();
    await expect(page.getByText("Fixture watchlist")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Connected to Simkl. Disconnect" }),
    ).toBeVisible();
    await expect(page.getByText(DRAFT_RESTORED)).toHaveCount(0);
    expect(await getConnectionRow(accountId, "simkl")).toMatchObject({
      provider_username: "fixture-user",
    });
  },
);

test(
  "a Provider turned off during the authorization says so and keeps the edits",
  { tag: "@local" },
  async ({ page }) => {
    const { api } = backend;
    const accountId = await seedTraktAccount();
    await routePageTo(page, backend.url);
    await openConfigure(page, accountId, "Fixture watchlist");
    await page.locator("#rpdb-api-key").fill("draft-rpdb-key");

    const comeBack = await connectFromPage(page, "Trakt", "auth.trakt.tv");
    // The kill switch turns Trakt off before the user comes back.
    const off = await startFixtureBackend("./provider-fixtures.ts", {
      DISABLED_PROVIDERS: "trakt",
    });
    try {
      await comeBack(off.url);
      await expect(page).toHaveURL(configureUrl(accountId));
      await expect(
        page.getByText(
          "Trakt is temporarily unavailable. Please try again later.",
        ),
      ).toBeVisible();
      await expect(page.getByText(DRAFT_RESTORED)).toBeVisible();
      await expect(page.locator("#rpdb-api-key")).toHaveValue("draft-rpdb-key");
      // No token was asked for and no Connection was stored.
      expect(off.requests((url) => url.pathname === "/oauth/token")).toEqual(
        [],
      );
      expect(await getConnectionRow(accountId, "trakt")).toBeNull();
      expect((await api.getConfig(accountId)).body.connections).toEqual([]);
    } finally {
      await off.stop();
    }
  },
);
