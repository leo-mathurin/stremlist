import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ProviderId } from "@stremlist/shared/providers";
import { CONNECTION_SOURCES } from "@stremlist/shared/providers";
import type {
  AccountConfigResponse,
  ConfigListInput,
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import {
  CONNECTION_ENCRYPTION_KEY,
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../env.js";
import {
  db,
  getAccountRow,
  getConnectionRow,
  resetDb,
  seedAccount,
  seedConnection,
  seedList,
} from "../helpers/db.js";
import type { ProviderBackend } from "../helpers/provider-backend.js";
import { startProviderBackend } from "../helpers/provider-backend.js";
import { getCacheManifest } from "../helpers/r2.js";
import {
  LEGACY_ACTIONS_USER,
  LEGACY_CONNECTION_USER,
} from "../helpers/test-data.js";

// Provider journeys against the real backend, database and R2 store. A
// separate backend runs with helpers/provider-fixtures.ts, which answers every
// Provider request with deterministic data (dummy client IDs, no real
// credentials) and logs what the backend sent. Letterboxd is out of scope.

let backend: ProviderBackend;
let logDir: string;
let logFile: string;

/** The variables of a fixture backend; `extra` adds or overrides some. */
function backendEnv(extra: Record<string, string> = {}) {
  return {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    CONNECTION_ENCRYPTION_KEY,
    FRONTEND_URL,
    RESEND_API_KEY: "re_fixture_only",
    TRAKT_CLIENT_ID: "fixture-trakt-client",
    SIMKL_CLIENT_ID: "fixture-simkl-client",
    MDBLIST_CLIENT_ID: "fixture-mdblist-client",
    E2E_PROVIDER_LOG: logFile,
    ...extra,
  };
}

test.beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "stremlist-provider-log-"));
  logFile = join(logDir, "requests.jsonl");
  backend = await startProviderBackend("./provider-fixtures.ts", backendEnv());
});
test.afterAll(async () => {
  await backend?.stop();
  rmSync(logDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetDb();
  writeFileSync(logFile, "");
  // The ID resolver caches SensCritique products across runs.
  await db
    .from("title_id_map")
    .delete()
    .eq("namespace", "senscritique")
    .in("external_id", ["101", "202"]);
});

interface LoggedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

function requests(match: (url: URL) => boolean): LoggedRequest[] {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest)
    .filter((entry) => match(new URL(entry.url)));
}

async function call<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; json?: unknown; base?: string } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${init.base ?? backend.url}${path}`, {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers:
      init.json === undefined ? {} : { "Content-Type": "application/json" },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    redirect: "manual",
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
  };
}

const resolve = (input: string, accountKey?: string) =>
  call("/links/resolve", { json: { input, accountKey } });

async function catalogNames(key: string, listId: string, type: string) {
  const { status, body } = await call<{ metas: StremioMeta[] }>(
    `/${key}/catalog/${type}/wl-${listId}-${type}.json`,
  );
  expect(status).toBe(200);
  return body.metas.map((meta) => meta.name);
}

const list = (
  provider: ProviderId,
  sourceRef: string,
  extra: Partial<ConfigListInput> = {},
): ConfigListInput => ({
  provider,
  sourceRef,
  sortOption: "added_at-asc",
  displayMode: "split",
  ...extra,
});

async function configLists(key: string) {
  return (await call<AccountConfigResponse>(`/${key}/config`)).body.lists;
}

test(
  "public links of Trakt, JustWatch and SensCritique become Catalogs",
  { tag: "@local" },
  async () => {
    const links = {
      trakt: "https://trakt.tv/users/fixture-user/watchlist",
      justwatch:
        "https://www.justwatch.com/us/lists/tl-us-11111111-2222-4333-8444-555555555555",
      senscritique:
        "https://www.senscritique.com/fixture-user/collection?action=WISH",
    };
    expect((await resolve(links.trakt)).body).toEqual({
      ok: true,
      provider: "trakt",
      sourceRef: "users/fixture-user/watchlist",
      kind: "watchlist",
      requiresConnection: false,
      suggestedTitle: "fixture-user's watchlist",
      defaultDisplayMode: "split",
    });
    expect((await resolve(links.justwatch)).body).toMatchObject({
      ok: true,
      provider: "justwatch",
      sourceRef: "tl-us-11111111-2222-4333-8444-555555555555",
      kind: "list",
      suggestedTitle: "Weekend picks",
    });
    expect((await resolve(links.senscritique)).body).toMatchObject({
      ok: true,
      provider: "senscritique",
      sourceRef: "users/fixture-user/wishes",
      kind: "watchlist",
    });
    // Expected refusals of the same Providers.
    expect(
      (await resolve("https://trakt.tv/users/private-user/watchlist")).body,
    ).toEqual({ ok: false, reason: "private", provider: "trakt" });
    expect(
      (
        await resolve(
          "https://www.justwatch.com/us/lists/tl-us-99999999-2222-4333-8444-555555555555",
        )
      ).body,
    ).toEqual({ ok: false, reason: "not_found", provider: "justwatch" });
    expect(
      (await resolve("https://www.senscritique.com/private-user")).body,
    ).toEqual({ ok: false, reason: "private", provider: "senscritique" });

    const created = await call<{ accountId: string }>("/accounts", {
      json: {
        lists: [
          list("trakt", "users/fixture-user/watchlist"),
          list("justwatch", "tl-us-11111111-2222-4333-8444-555555555555"),
          list("senscritique", "users/fixture-user/wishes"),
        ],
      },
    });
    expect(created.status).toBe(200);
    const { accountId } = created.body;
    const lists = await configLists(accountId);
    expect(lists.map((row) => row.provider)).toEqual([
      "trakt",
      "justwatch",
      "senscritique",
    ]);
    for (const row of lists) {
      expect(await catalogNames(accountId, row.id, "movie")).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await catalogNames(accountId, row.id, "series")).toEqual([
        "Breaking Bad",
      ]);
    }
    // Public reads carry the app's client ID and no user token.
    const traktReads = requests((url) => url.host === "api.trakt.tv");
    expect(traktReads.length).toBeGreaterThan(0);
    expect(traktReads.every((entry) => entry.authorization === null)).toBe(
      true,
    );
    // SensCritique products resolved to IMDb IDs through Wikidata.
    expect(
      requests((url) => url.host === "query.wikidata.org").length,
    ).toBeGreaterThan(0);
  },
);

test(
  "MDBList and Simkl Source lists read through a Connection",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "mdblist");
    await seedConnection(accountId, "simkl");
    const link = "https://mdblist.com/lists/fixture-user/weekend";
    expect((await resolve(link)).body).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
    expect((await resolve(link, accountId)).body).toMatchObject({
      ok: true,
      provider: "mdblist",
      sourceRef: "lists/4242",
      requiresConnection: true,
      suggestedTitle: "Weekend",
    });
    const sources = await call<{ sources: { ref: string; label: string }[] }>(
      `/${accountId}/connections/mdblist/sources`,
    );
    expect(sources.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "me/watchlist" }),
        expect.objectContaining({ ref: "me/lists/77", label: "Horror nights" }),
      ]),
    );

    const saved = await call(`/${accountId}/config`, {
      json: {
        lists: [
          list("mdblist", "lists/4242", { catalogTitle: "Weekend" }),
          list("simkl", "me/plantowatch"),
        ],
      },
    });
    expect(saved.status).toBe(200);
    for (const row of await configLists(accountId)) {
      expect(await catalogNames(accountId, row.id, "movie")).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await catalogNames(accountId, row.id, "series")).toEqual([
        "Breaking Bad",
      ]);
    }
    for (const host of ["api.mdblist.com", "api.simkl.com"]) {
      const reads = requests((url) => url.host === host);
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.every((entry) => entry.authorization === "fixture-access-token"),
      ).toBe(true);
    }
  },
);

test(
  "Trakt OAuth start and callback store an encrypted Connection",
  { tag: "@local" },
  async () => {
    const { body: created } = await call<{ accountId: string }>("/accounts", {
      json: { lists: [] },
    });
    const accountId = created.accountId;
    const start = async () => {
      const response = await call<{ authorizeUrl: string }>(
        `/${accountId}/connections/trakt/start`,
        { method: "POST" },
      );
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
    const { data: pending } = await db
      .from("oauth_states")
      .select("provider")
      .eq("state", state);
    expect(pending).toEqual([{ provider: "trakt" }]);

    const callback = await fetch(
      `${backend.url}/oauth/trakt/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      `${FRONTEND_URL}/configure?account=${accountId}&connected=trakt`,
    );
    // PKCE: the token request proves the verifier behind the challenge.
    const [exchange] = requests(
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
    const config = await call<AccountConfigResponse>(`/${accountId}/config`);
    expect(config.body.connections).toMatchObject([
      { provider: "trakt", username: "fixture-user" },
    ]);

    // A state works once; a refusal and a broken request say why.
    const replay = await fetch(
      `${backend.url}/oauth/trakt/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(replay.headers.get("location")).toBe(
      `${FRONTEND_URL}/configure?connection_error=expired&provider=trakt`,
    );
    const second = (await start()).searchParams.get("state")!;
    const denied = await fetch(
      `${backend.url}/oauth/trakt/callback?error=access_denied&state=${encodeURIComponent(second)}`,
      { redirect: "manual" },
    );
    expect(denied.headers.get("location")).toBe(
      `${FRONTEND_URL}/configure?account=${accountId}&connection_error=denied&provider=trakt`,
    );
    const invalid = await fetch(`${backend.url}/oauth/trakt/callback`, {
      redirect: "manual",
    });
    expect(invalid.headers.get("location")).toBe(
      `${FRONTEND_URL}/configure?connection_error=invalid_request`,
    );

    // The Connection unlocks private Source lists and the user's own lists.
    expect(
      (await resolve("https://trakt.tv/users/me/watchlist", accountId)).body,
    ).toMatchObject({ ok: true, provider: "trakt", sourceRef: "me/watchlist" });
    const sources = await call<{ sources: { ref: string; label: string }[] }>(
      `/${accountId}/connections/trakt/sources`,
    );
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
        await call(`/${accountId}/config`, {
          json: { lists: [list("trakt", "me/watchlist")] },
        })
      ).status,
    ).toBe(200);
    const [saved] = await configLists(accountId);
    expect(await catalogNames(accountId, saved.id, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
    expect(
      requests((url) => url.pathname === "/users/me/watchlist").every(
        (entry) => entry.authorization === "fresh-access",
      ),
    ).toBe(true);
  },
);

test(
  "disconnecting revokes the token and private Lists ask to connect again",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const listId = await seedList(accountId, {
      provider: "trakt",
      sourceRef: "me/watchlist",
      catalogTitle: "Trakt Watchlist",
      position: 0,
      displayMode: "split",
    });
    expect(await catalogNames(accountId, listId, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);

    const removed = await call(`/${accountId}/connections/trakt`, {
      method: "DELETE",
    });
    expect(removed).toEqual({ status: 200, body: { ok: true } });
    const [revoke] = requests((url) => url.pathname === "/oauth/revoke");
    expect(revoke.body).toEqual({
      token: "fixture-access-token",
      client_id: "fixture-trakt-client",
    });
    expect(await getConnectionRow(accountId, "trakt")).toBeNull();
    // Nothing read through the Connection stays stored or served.
    expect(await getCacheManifest(listId)).toMatchObject({ deleted: true });
    const { body } = await call<{ metas: StremioMeta[] }>(
      `/${accountId}/catalog/movie/wl-${listId}-movie.json`,
    );
    expect(body.metas).toMatchObject([
      {
        id: "stremlist:unavailable:needs_connection",
        name: "⚠️ This watchlist needs your Trakt account",
        description: "Connect Trakt on the Stremlist configure page.",
      },
    ]);
    const config = await call<AccountConfigResponse>(`/${accountId}/config`);
    expect(config.body.connections).toEqual([]);
    expect(config.body.lists).toMatchObject([{ sourceRef: "me/watchlist" }]);
  },
);

test(
  "an expired Connection refreshes, or asks to connect again when refused",
  { tag: "@local" },
  async () => {
    const past = new Date(Date.now() - 60_000);
    const refused = await seedAccount();
    await seedConnection(refused, "trakt", {
      expiresAt: past,
      refreshToken: "rejected-refresh",
    });
    const refusedList = await seedList(refused, {
      provider: "trakt",
      sourceRef: "me/watchlist",
      catalogTitle: "",
      position: 0,
    });
    const { body } = await call<{ metas: StremioMeta[] }>(
      `/${refused}/catalog/movie/wl-${refusedList}-movie.json`,
    );
    expect(body.metas).toMatchObject([
      {
        id: "stremlist:unavailable:needs_connection",
        name: "⚠️ This watchlist needs your Trakt account",
      },
    ]);
    // The refresh used the redirect URI stored with the Connection.
    expect(
      requests((url) => url.pathname === "/oauth/token").map(
        (entry) => entry.body,
      ),
    ).toEqual([
      expect.objectContaining({
        grant_type: "refresh_token",
        refresh_token: "rejected-refresh",
        redirect_uri: `http://127.0.0.1:7301/oauth/trakt/callback`,
      }),
    ]);

    const renewed = await seedAccount();
    await seedConnection(renewed, "trakt", { expiresAt: past });
    const renewedList = await seedList(renewed, {
      provider: "trakt",
      sourceRef: "me/watchlist",
      catalogTitle: "",
      position: 0,
    });
    const before = await getConnectionRow(renewed, "trakt");
    expect(await catalogNames(renewed, renewedList, "movie")).toEqual([
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
    const manifest = await call<StremioManifest>(`/${alias}/manifest.json`);
    expect(manifest.body.catalogs.map((catalog) => catalog.id)).toEqual([
      `wl-${publicList}-movie`,
    ]);
    expect(
      manifest.body.resources.some(
        (resource) =>
          typeof resource === "object" && resource.name === "stream",
      ),
    ).toBe(false);
    const config = await call<AccountConfigResponse>(`/${alias}/config`);
    expect(config.body).toMatchObject({
      access: "legacy",
      accountId: null,
      connections: [],
    });
    expect(config.body.lists.map((row) => row.id)).toEqual([publicList]);
    expect(await catalogNames(alias, privateList, "movie")).toEqual([]);
    expect(await catalogNames(alias, publicList, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);
    // The Account ID of a legacy Account is no second way in.
    expect((await call(`/${accountId}/config`)).status).toBe(404);
    expect(
      (
        await call(`/${alias}/config`, {
          json: { lists: [list("trakt", "me/watchlist")] },
        })
      ).body,
    ).toEqual({
      error:
        "Trakt lists need your private Addon URL. Upgrade this install first.",
    });

    // The upgrade copies the Lists to a private Account, not the Connection.
    const upgraded = await call<{ accountId: string }>(`/${alias}/upgrade`, {
      method: "POST",
    });
    expect(upgraded.status).toBe(200);
    const copy = upgraded.body.accountId;
    expect((await configLists(copy)).map((row) => row.sourceRef)).toEqual([
      "users/fixture-user/watchlist",
      "me/watchlist",
    ]);
    expect(await getConnectionRow(copy, "trakt")).toBeNull();
    expect((await getAccountRow(accountId))?.moved_at).not.toBeNull();
    expect(
      (
        await call(`/${alias}/config`, {
          json: { lists: [list("trakt", "users/fixture-user/watchlist")] },
        })
      ).status,
    ).toBe(409);
  },
);

test(
  "Actions in Stremio open a Stremlist page that changes the Trakt watchlist",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const saved = await call(`/${accountId}/config`, {
      json: {
        lists: [list("trakt", "users/fixture-user/watchlist")],
        actions: { enabled: true, providers: ["trakt"] },
      },
    });
    expect(saved.status).toBe(200);
    const manifest = await call<StremioManifest>(`/${accountId}/manifest.json`);
    expect(manifest.body.resources).toContainEqual({
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    });

    const streams = await call<{
      streams: { name: string; title?: string; externalUrl?: string }[];
    }>(`/${accountId}/stream/movie/tt0111161.json`);
    const add = streams.body.streams.find((stream) =>
      stream.externalUrl?.includes("/actions/watchlist/add/"),
    );
    expect(add?.externalUrl).toBe(
      `${backend.url}/${accountId}/actions/watchlist/add/movie/tt0111161`,
    );

    await page.goto(add!.externalUrl!);
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is in your watchlist on Trakt",
      }),
    ).toBeVisible();
    const writes = requests((url) => url.pathname === "/sync/watchlist");
    expect(writes).toMatchObject([
      {
        method: "POST",
        authorization: "fixture-access-token",
        body: { movies: [{ ids: { imdb: "tt0111161" } }] },
      },
    ]);

    // Actions never answer through a Legacy alias or without a Connection.
    const alias = LEGACY_ACTIONS_USER;
    await seedAccount({ legacyImdbUserId: alias });
    expect((await call(`/${alias}/stream/movie/tt0111161.json`)).body).toEqual({
      streams: [],
      cacheMaxAge: 0,
    });
    await call(`/${accountId}/connections/trakt`, { method: "DELETE" });
    expect(
      (
        await call<{ streams: unknown[] }>(
          `/${accountId}/stream/movie/tt0111161.json`,
        )
      ).body.streams,
    ).toEqual([]);
  },
);

test(
  "Simkl and MDBList OAuth round trips store their Connection",
  { tag: "@local" },
  async () => {
    const { body: created } = await call<{ accountId: string }>("/accounts", {
      json: { lists: [] },
    });
    const accountId = created.accountId;
    for (const [provider, authorizeUrl, clientId] of [
      ["simkl", "https://simkl.com/oauth2/authorize", "fixture-simkl-client"],
      [
        "mdblist",
        "https://mdblist.com/oauth/authorize/",
        "fixture-mdblist-client",
      ],
    ] as const) {
      const start = await call<{ authorizeUrl: string }>(
        `/${accountId}/connections/${provider}/start`,
        { method: "POST" },
      );
      expect(start.status).toBe(200);
      const authorize = new URL(start.body.authorizeUrl);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(authorizeUrl);
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        response_type: "code",
        client_id: clientId,
        redirect_uri: `${backend.url}/oauth/${provider}/callback`,
      });
      const state = authorize.searchParams.get("state")!;
      const callback = await fetch(
        `${backend.url}/oauth/${provider}/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(
        `${FRONTEND_URL}/configure?account=${accountId}&connected=${provider}`,
      );
      const row = await getConnectionRow(accountId, provider);
      expect(row).toMatchObject({
        provider_username: "fixture-user",
        redirect_uri: `${backend.url}/oauth/${provider}/callback`,
      });
      expect(row?.access_token).toMatch(/^v1:/);
    }
    const config = await call<AccountConfigResponse>(`/${accountId}/config`);
    expect(
      config.body.connections.map((connection) => connection.provider).sort(),
    ).toEqual(["mdblist", "simkl"]);
    // Both token exchanges sent the one-time code.
    expect(
      requests((url) => /\/oauth2?\/token\/?$/.test(url.pathname)).map(
        (entry) => entry.body?.code,
      ),
    ).toEqual(["fixture-code", "fixture-code"]);
  },
);

test(
  "every Trakt Action intent opens its page, writes Trakt and updates the entries",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await db
      .from("accounts")
      .update({ actions_enabled: true, action_providers: ["trakt"] })
      .eq("id", accountId);
    const entries = async (type: string, id: string) =>
      (
        await call<{ streams: { title?: string; externalUrl?: string }[] }>(
          `/${accountId}/stream/${type}/${id}.json`,
        )
      ).body.streams;
    const action = (path: string) =>
      `${backend.url}/${accountId}/actions/${path}`;
    const writes = (path: string) =>
      requests((url) => url.pathname === path).map((entry) => entry.body);

    // Watched, for one episode, then undone from the updated entry.
    await page.goto(action("watched/add/series/tt0903747%3A1%3A2"));
    await expect(
      page.getByRole("heading", {
        name: "✓ Breaking Bad S01E02 is marked as watched on Trakt",
      }),
    ).toBeVisible();
    const episode = {
      shows: [
        {
          ids: { imdb: "tt0903747" },
          seasons: [{ number: 1, episodes: [{ number: 2 }] }],
        },
      ],
    };
    expect(writes("/sync/history")).toEqual([episode]);
    const watched = (await entries("series", "tt0903747:1:2")).find((entry) =>
      entry.title?.startsWith("✅"),
    );
    expect(watched).toEqual({
      name: "Stremlist",
      title: "✅ S01E02 watched on Trakt\nSelect to mark as unwatched",
      externalUrl: action("watched/remove/series/tt0903747%3A1%3A2"),
    });
    await page.goto(watched!.externalUrl!);
    await expect(
      page.getByRole("heading", {
        name: "✓ Breaking Bad S01E02 is marked as unwatched on Trakt",
      }),
    ).toBeVisible();
    expect(writes("/sync/history/remove")).toEqual([episode]);

    // Watchlist: add, then remove from the entry that says it is there.
    const movie = { movies: [{ ids: { imdb: "tt0111161" } }] };
    await page.goto(action("watchlist/add/movie/tt0111161"));
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is in your watchlist on Trakt",
      }),
    ).toBeVisible();
    const inWatchlist = (await entries("movie", "tt0111161"))[0];
    expect(inWatchlist).toEqual({
      name: "Stremlist",
      title: "🔖 In your Trakt watchlist\nSelect to remove",
      externalUrl: action("watchlist/remove/movie/tt0111161"),
    });
    await page.goto(inWatchlist.externalUrl!);
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is out of your watchlist on Trakt",
      }),
    ).toBeVisible();
    expect(writes("/sync/watchlist/remove")).toEqual([movie]);

    // Rating: a form with 1 to 10, then the saved rating can be removed.
    const rate = (await entries("movie", "tt0111161")).at(-1);
    expect(rate).toEqual({
      name: "Stremlist",
      title: "⭐ Rate on Trakt",
      externalUrl: action("rating/rate/movie/tt0111161"),
    });
    await page.goto(rate!.externalUrl!);
    await expect(
      page.getByRole("heading", { name: "Rate The Shawshank Redemption" }),
    ).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(10);
    await expect(page.getByRole("checkbox", { name: "Trakt" })).toBeChecked();
    await expect(page.getByText("Not rated")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove rating" }),
    ).toHaveCount(0);
    await page.getByText("8", { exact: true }).click();
    await page.getByRole("button", { name: "Save rating" }).click();
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is rated 8/10 on Trakt",
      }),
    ).toBeVisible();
    expect(writes("/sync/ratings")).toEqual([
      { movies: [{ ids: { imdb: "tt0111161" }, rating: 8 }] },
    ]);
    expect((await entries("movie", "tt0111161")).at(-1)?.title).toBe(
      "⭐ Rated 8/10, change\nTrakt",
    );
    await page.goto(rate!.externalUrl!);
    await expect(page.getByText("Now 8/10")).toBeVisible();
    await expect(page.getByRole("radio", { name: "8" })).toBeChecked();
    await page.getByRole("button", { name: "Remove rating" }).click();
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption has no rating on Trakt now",
      }),
    ).toBeVisible();
    expect(writes("/sync/ratings/remove")).toEqual([movie]);

    // A link with an unknown intent, or for another Account, changes nothing.
    const before = requests((url) => url.pathname.startsWith("/sync/")).length;
    for (const path of [
      `/${accountId}/actions/watchlist/toggle/movie/tt0111161`,
      `/${accountId}/actions/watched/add/movie/not-a-title`,
      "/sl_0000000000000000000000/actions/watchlist/add/movie/tt0111161",
    ]) {
      const response = await page.goto(`${backend.url}${path}`);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { name: "This link does not work" }),
      ).toBeVisible();
    }
    expect(requests((url) => url.pathname.startsWith("/sync/")).length).toBe(
      before,
    );
  },
);

test(
  "the kill switch stops every Provider request but keeps cached Catalogs",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await db
      .from("accounts")
      .update({ actions_enabled: true, action_providers: ["trakt"] })
      .eq("id", accountId);
    const justwatchRef = "tl-us-11111111-2222-4333-8444-555555555555";
    const cached = await seedList(accountId, {
      provider: "justwatch",
      sourceRef: justwatchRef,
      catalogTitle: "",
      position: 0,
    });
    const uncached = await seedList(accountId, {
      provider: "senscritique",
      sourceRef: "users/fixture-user/wishes",
      catalogTitle: "",
      position: 1,
    });
    // The running backend reads the JustWatch list once, into R2.
    expect(await catalogNames(accountId, cached, "movie")).toEqual([
      "The Shawshank Redemption",
    ]);

    const off = await startProviderBackend(
      "./provider-fixtures.ts",
      backendEnv({ DISABLED_PROVIDERS: "justwatch,senscritique,trakt" }),
    );
    try {
      writeFileSync(logFile, "");
      const at = { base: off.url };
      const status = await call<{
        providers: { id: string; enabled: boolean }[];
      }>("/providers", at);
      expect(
        status.body.providers
          .filter((provider) => !provider.enabled)
          .map((provider) => provider.id)
          .sort(),
      ).toEqual(["justwatch", "senscritique", "trakt"]);
      expect(
        (
          await call("/links/resolve", {
            ...at,
            json: {
              input: `https://www.justwatch.com/us/lists/${justwatchRef}`,
            },
          })
        ).body,
      ).toEqual({ ok: false, reason: "disabled", provider: "justwatch" });

      // The cached Catalog stays; a List without a cache explains why.
      const catalog = async (listId: string) =>
        (
          await call<{ metas: StremioMeta[] }>(
            `/${accountId}/catalog/movie/wl-${listId}-movie.json`,
            at,
          )
        ).body.metas;
      expect((await catalog(cached)).map((meta) => meta.name)).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await catalog(uncached)).toMatchObject([
        {
          id: "stremlist:unavailable:disabled",
          name: "⚠️ SensCritique is temporarily unavailable",
          description: "Please try again later.",
        },
      ]);

      // No Connection, own list or Action goes through a Provider that is off.
      expect(
        await call(`/${accountId}/connections/trakt/start`, {
          ...at,
          method: "POST",
        }),
      ).toEqual({
        status: 503,
        body: { error: "Trakt is temporarily unavailable." },
      });
      expect(
        (await call(`/${accountId}/connections/trakt/sources`, at)).body,
      ).toEqual({ sources: CONNECTION_SOURCES.trakt });
      expect(
        (await call(`/${accountId}/stream/movie/tt0111161.json`, at)).body,
      ).toEqual({ streams: [], cacheMaxAge: 0 });
      expect(requests(() => true)).toEqual([]);
    } finally {
      await off.stop();
    }
  },
);
