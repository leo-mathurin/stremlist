import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createHash } from "node:crypto";
import { http, HttpResponse } from "msw";
import app from "../index.js";
import { decryptSecret } from "../lib/crypto";
import { forgetConnectionObjects } from "../services/actions";
import {
  OAuthNotConfiguredError,
  redirectUri,
  startAuthorization,
} from "../services/oauth";
import {
  applySynchronization,
  historyApplies,
  historyKey,
  readHistory,
} from "../services/title-history";
import {
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  useTestEncryptionKey,
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import { cache } from "./helpers/list-cache.test-utils.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";
import { z } from "zod";
import { accountIdBody, mustString, readJson } from "./helpers/json.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { r2Objects, resetR2 } from "./helpers/r2.test-utils.js";
import { useTraktApp } from "./helpers/trakt.test-utils.js";

const AUTHORIZE_URL = "https://auth.trakt.tv/oauth/authorize";
const TOKEN_URL = "https://auth.trakt.tv/oauth/token";
const TRAKT_SETTINGS = "https://api.trakt.tv/users/settings";
const TRAKT_LISTS = "https://api.trakt.tv/users/me/lists";
const TRAKT_SMART_LISTS = "https://api.trakt.tv/users/me/smart-lists";

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();
const storageHosts = new Set(
  [process.env.SUPABASE_URL, process.env.R2_ENDPOINT].map(
    (url) => new URL(url ?? "http://localhost").host,
  ),
);
const requests: Request[] = [];
server.events.on("request:start", ({ request }) => {
  if (!storageHosts.has(new URL(request.url).host)) {
    requests.push(request.clone());
  }
});

function serveToken(body: Record<string, unknown>, status = 200) {
  server.use(http.post(TOKEN_URL, () => HttpResponse.json(body, { status })));
}

function serveTraktUser(username: string) {
  server.use(
    http.get(TRAKT_SETTINGS, () => HttpResponse.json({ user: { username } })),
  );
}

function useOAuthProvider(prefix = "TRAKT") {
  vi.stubEnv(`${prefix}_CLIENT_ID`, "client-123");
  vi.stubEnv(`${prefix}_CLIENT_SECRET`, "secret-456");
}

function withoutClientId() {
  vi.stubEnv("TRAKT_CLIENT_ID", "");
}

const oauthStateRow = z
  .object({
    state: z.string(),
    code_verifier: z.string(),
    expires_at: z.string(),
  })
  .loose();

function stateRow() {
  const row = db.getTable("oauth_states").at(0);
  if (!row) throw new Error("no pending authorization");
  return oauthStateRow.parse(row);
}

const startBody = z
  .object({ ok: z.boolean(), authorizeUrl: z.string(), browserKey: z.string() })
  .loose();

const BROWSER_KEY = "browser-key-1";

function seedState(
  accountId: string | null,
  overrides: { state?: string; expiresAt?: Date; provider?: string } = {},
) {
  db.insert("oauth_states", {
    state: overrides.state ?? "state-abc",
    account_id: accountId,
    provider: overrides.provider ?? "trakt",
    code_verifier: "verifier-xyz",
    browser_key_hash: createHash("sha256")
      .update(BROWSER_KEY)
      .digest("base64url"),
    expires_at: (
      overrides.expiresAt ?? new Date(Date.now() + 10 * 60_000)
    ).toISOString(),
  });
}

function callback(query: Record<string, string>, provider = "trakt") {
  return app.request(
    `/oauth/${provider}/callback?${new URLSearchParams(query).toString()}`,
  );
}

function complete(body: Record<string, unknown> = {}, provider = "trakt") {
  return app.request(`/connections/${provider}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: "state-abc",
      code: "code-1",
      browserKey: BROWSER_KEY,
      ...body,
    }),
  });
}

function redirectParams(response: Response) {
  const location = response.headers.get("Location");
  if (!location) throw new Error("not a redirect");
  const url = new URL(location);
  return {
    path: url.pathname,
    params: Object.fromEntries(url.searchParams),
    fragment: Object.fromEntries(new URLSearchParams(url.hash.slice(1))),
  };
}

let accountId = "";

beforeEach(() => {
  db.reset();
  resetR2();
  cache.reset();
  resetRpc();
  imdb.reset();
  server.use(imdb.handler, cinemetaWithoutTitles);
  useTestEncryptionKey();
  requests.length = 0;
  useTraktApp();
  accountId = seedAccount().id;
  vi.spyOn(console, "error");
});

afterEach(async () => {
  await background.settle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startAuthorization", () => {
  it("builds a PKCE authorize URL and remembers the verifier under the state", async () => {
    useOAuthProvider("SIMKL");

    const { authorizeUrl, browserKey } = await startAuthorization(
      accountId,
      "simkl",
      "https://api.stremlist.test",
    );
    const url = new URL(authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://simkl.com/oauth2/authorize",
    );
    const params = Object.fromEntries(url.searchParams);
    const row = stateRow();
    expect(params).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "https://api.stremlist.test/oauth/simkl/callback",
      state: row.state,
      code_challenge: createHash("sha256")
        .update(row.code_verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
      scope: "media:read media:write",
    });
    expect(row).toMatchObject({ account_id: accountId, provider: "simkl" });
    expect(row.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(url.toString()).not.toContain(row.code_verifier);
    expect(browserKey).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(url.toString()).not.toContain(browserKey);
    expect(row.browser_key_hash).toBe(
      createHash("sha256").update(browserKey).digest("base64url"),
    );
    const ttl = Date.parse(row.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });

  it("uses a new state and verifier for every authorization", async () => {
    useOAuthProvider();

    await startAuthorization(accountId, "trakt", "https://api.stremlist.test");
    await startAuthorization(accountId, "trakt", "https://api.stremlist.test");

    const [first, second] = db.getTable("oauth_states");
    expect(first.state).not.toBe(second.state);
    expect(first.code_verifier).not.toBe(second.code_verifier);
    expect(first.browser_key_hash).not.toBe(second.browser_key_hash);
  });

  it("refuses a Provider without a client ID", async () => {
    withoutClientId();

    await expect(
      startAuthorization(accountId, "trakt", "https://api.stremlist.test"),
    ).rejects.toBeInstanceOf(OAuthNotConfiguredError);
    expect(db.getTable("oauth_states")).toEqual([]);
  });

  it("prefers BACKEND_PUBLIC_URL for the redirect URI", async () => {
    useOAuthProvider();
    vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.stremlist.com/");
    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });
    const { authorizeUrl } = await readJson(res, startBody);

    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "https://api.stremlist.com/oauth/trakt/callback",
    );
    expect(redirectUri("trakt", "https://api.stremlist.com")).toBe(
      "https://api.stremlist.com/oauth/trakt/callback",
    );
  });
});

describe("POST /:accountId/connections/:provider/start", () => {
  it("answers the authorize URL for a private Account", async () => {
    useOAuthProvider();

    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await readJson(res, startBody);
    expect(body.ok).toBe(true);
    expect(body.authorizeUrl.startsWith(AUTHORIZE_URL)).toBe(true);
    expect(body.browserKey).toEqual(expect.any(String));
  });

  it("starts a new setup without creating an Account", async () => {
    useOAuthProvider();
    const accounts = db.getTable("accounts").length;

    const res = await app.request("/connections/trakt/start", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(stateRow()).toMatchObject({ account_id: null, provider: "trakt" });
    expect(db.getTable("accounts")).toHaveLength(accounts);
  });

  it("refuses an Account that has a Legacy alias", async () => {
    useOAuthProvider();
    const legacy = seedLegacyAccount("ur12345678");

    const res = await app.request(`/${legacy.id}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(db.getTable("oauth_states")).toEqual([]);
  });

  it("says when the Provider cannot be connected yet", async () => {
    withoutClientId();

    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
  });

  it("refuses a turned-off Provider", async () => {
    useOAuthProvider();
    vi.stubEnv("DISABLED_PROVIDERS", "trakt");

    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
  });
});

describe("GET /:accountId/connections/:provider/sources", () => {
  it("lists the user's own lists through the Connection", async () => {
    server.use(
      http.get(TRAKT_LISTS, () =>
        HttpResponse.json([{ name: "Horror", ids: { trakt: 42 } }]),
      ),
      http.get(TRAKT_SMART_LISTS, () => HttpResponse.json([])),
    );
    seedConnection(accountId, "trakt");

    const res = await app.request(`/${accountId}/connections/trakt/sources`);
    const body = await readJson(
      res,
      z.object({
        sources: z.array(z.object({ ref: z.string() }).loose()),
      }),
    );

    expect(body.sources.map((source) => source.ref)).toContain("me/lists/42");
    expect(
      requests.filter((request) => request.url.startsWith(TRAKT_LISTS)),
    ).toHaveLength(1);
  });

  it("does not call a turned-off Provider", async () => {
    server.use(
      http.get(TRAKT_LISTS, () => HttpResponse.json([])),
      http.get(TRAKT_SMART_LISTS, () => HttpResponse.json([])),
    );
    seedConnection(accountId, "trakt");
    vi.stubEnv("DISABLED_PROVIDERS", "trakt");

    const res = await app.request(`/${accountId}/connections/trakt/sources`);

    expect(res.status).toBe(200);
    expect(requests).toEqual([]);
  });
});

describe("OAuth login CSRF", () => {
  async function attackerStart() {
    const start = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });
    const { authorizeUrl, browserKey } = await readJson(start, startBody);
    serveToken({ access_token: "victim" });
    serveTraktUser("victim");
    return {
      state: new URL(authorizeUrl).searchParams.get("state") ?? "",
      browserKey,
    };
  }

  it("links nothing when the consent link is opened in another browser", async () => {
    useOAuthProvider();
    const { state } = await attackerStart();

    const res = await callback({ code: "victim-code", state });
    await background.settle();

    expect(redirectParams(res).params.connected).toBeUndefined();
    expect(requests).toEqual([]);
    expect(db.getTable("connections")).toEqual([]);
  });

  it("refuses a completion with the key of another browser", async () => {
    useOAuthProvider();
    const { state } = await attackerStart();

    const res = await complete({
      state,
      code: "victim-code",
      browserKey: "victim-browser-key",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "expired" });
    expect(requests).toEqual([]);
    expect(db.getTable("connections")).toEqual([]);
    expect(db.getTable("oauth_states")).toHaveLength(1);
  });

  it("still completes in the browser that started it", async () => {
    useOAuthProvider();
    const { state, browserKey } = await attackerStart();

    const res = await complete({ state, browserKey });

    expect(res.status).toBe(200);
    expect(db.getTable("connections")).toHaveLength(1);
  });
});

describe("GET /oauth/:provider/callback", () => {
  it("hands the code to the configure page in the fragment, unused", async () => {
    useOAuthProvider();
    seedState(accountId);

    const res = await callback({ code: "code-1", state: "state-abc" });

    expect(res.status).toBe(302);
    expect(redirectParams(res)).toEqual({
      path: "/configure",
      params: {},
      fragment: { oauth: "trakt", state: "state-abc", code: "code-1" },
    });
    expect(requests).toEqual([]);
    expect(db.getTable("oauth_states")).toHaveLength(1);
  });

  it.each([
    ["access_denied", "denied"],
    ["server_error", "failed"],
  ])("hands an error %s to the configure page as %s", async (error, reason) => {
    const res = await callback({ error, state: "state-abc" });

    expect(redirectParams(res).fragment).toEqual({
      oauth: "trakt",
      state: "state-abc",
      oauth_error: reason,
    });
  });

  it.each([
    [{ code: "code-1" }, "trakt"],
    [{ code: "code-1", state: "state-abc" }, "netflix"],
  ])("rejects an invalid request %j for %s", async (query, provider) => {
    const res = await callback(query, provider);

    expect(redirectParams(res).params).toEqual({
      connection_error: "invalid_request",
    });
  });
});

describe("POST /connections/:provider/complete", () => {
  it.each(["leo", "another-user"])(
    "keeps durable history on renewal, applying it only to its owner (%s)",
    async (username) => {
      useOAuthProvider();
      const original = seedConnection(accountId, "trakt", { username: "leo" });
      const source = { provider: "trakt" as const, sourceRef: "me/history" };
      const identity = { user: "leo", connectedAt: original.created_at };
      const baseline = applySynchronization(
        null,
        source,
        [],
        new Date("2026-01-01"),
        identity,
      );
      const detected = applySynchronization(
        baseline?.history ?? null,
        source,
        [{ key: "imdb:tt1", imdbId: "tt1" }],
        new Date("2026-01-02"),
        identity,
      );
      if (!detected) throw new Error("missing history");
      const key = historyKey(accountId, source);
      r2Objects.set(key, JSON.stringify(detected.history));
      const prefix = `connections/${accountId}/trakt/`;
      for (const name of [
        "membership.json",
        "library.json",
        "lists/1.json",
        "lists/2.json",
      ])
        r2Objects.set(prefix + name, "{}");
      const before = r2Objects.get(key);
      seedState(accountId);
      serveToken({ access_token: "renewed" });
      serveTraktUser(username);

      const response = await complete();
      expect(await response.json()).toMatchObject({ ok: true, accountId });
      await background.settle();

      expect([...r2Objects.keys()]).toEqual([key]);
      expect(r2Objects.get(key)).toBe(before);
      const history = await readHistory(accountId, source);
      if (!history) throw new Error("missing stored history");
      const current = db.getTable("connections")[0];
      expect(
        historyApplies(history, source, {
          user: username,
          connectedAt: String(current.created_at),
        }),
      ).toBe(username === "leo");
      await forgetConnectionObjects(accountId, "trakt");
      expect(r2Objects.size).toBe(0);
    },
  );

  it("exchanges the code and stores the encrypted Connection", async () => {
    useOAuthProvider();
    seedState(accountId);
    serveToken({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 7200,
      scope: "public",
    });
    serveTraktUser("leo");

    const res = await complete();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accountId, created: false });

    const tokenRequests = requests.filter(
      (request) => request.url === TOKEN_URL,
    );
    expect(tokenRequests).toHaveLength(1);
    const [token] = tokenRequests;
    expect(token.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(await token.text()))).toEqual(
      {
        client_id: "client-123",
        client_secret: "secret-456",
        grant_type: "authorization_code",
        code: "code-1",
        code_verifier: "verifier-xyz",
        redirect_uri: "http://localhost/oauth/trakt/callback",
      },
    );
    expect(token.headers.get("User-Agent")).toMatch(/^Stremlist\//);
    expect(
      requests
        .find((request) => request.url === TRAKT_SETTINGS)
        ?.headers.get("Authorization"),
    ).toBe("Bearer access-1");

    const [row] = db.getTable("connections");
    expect(row).toMatchObject({
      account_id: accountId,
      provider: "trakt",
      provider_username: "leo",
      scope: "public",
      redirect_uri: "http://localhost/oauth/trakt/callback",
    });
    expect(decryptSecret(mustString(row.access_token, "access_token"))).toBe(
      "access-1",
    );
    expect(decryptSecret(mustString(row.refresh_token, "refresh_token"))).toBe(
      "refresh-1",
    );
    expect(JSON.stringify(row)).not.toContain("access-1");
    expect(db.getTable("oauth_states")).toEqual([]);
  });

  it("still connects when the username cannot be fetched", async () => {
    useOAuthProvider();
    seedState(accountId);
    serveToken({ access_token: "access-1" });
    server.use(
      http.get(TRAKT_SETTINGS, () => new HttpResponse(null, { status: 503 })),
    );

    const res = await complete();

    expect(res.status).toBe(200);
    expect(db.getTable("connections")[0]).toMatchObject({
      provider_username: null,
      refresh_token: null,
      expires_at: null,
    });
  });

  it("creates the Account of a new setup only when the connection succeeds", async () => {
    useOAuthProvider();
    seedState(null);
    serveToken({ access_token: "access-1" });
    serveTraktUser("leo");
    const before = db.getTable("accounts").length;

    const res = await complete({
      setup: {
        rpdbApiKey: "rpdb",
        lists: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider: "imdb",
            sourceRef: "ls123456789",
            catalogTitle: "Kept",
            sortOption: "added_at-desc",
          },
        ],
        newTitles: { enabled: true },
      },
    });

    expect(res.status).toBe(200);
    const body = await readJson(
      res,
      accountIdBody.extend({ created: z.boolean() }),
    );
    expect(body.created).toBe(true);
    expect(body.accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
    expect(db.getTable("accounts")).toHaveLength(before + 1);
    expect(
      db.getTable("accounts").find((row) => row.id === body.accountId),
    ).toMatchObject({ rpdb_api_key: "rpdb", new_titles_catalog: true });
    expect(
      db
        .getTable("lists")
        .filter((row) => row.account_id === body.accountId)
        .map((row) => row.catalog_title),
    ).toEqual(["Kept"]);
    expect(db.getTable("connections")[0]).toMatchObject({
      account_id: body.accountId,
      provider: "trakt",
    });
  });

  it.each([
    [
      "an expired authorization",
      { expiresAt: new Date(Date.now() - 1000) },
      {},
    ],
    ["an unknown state", {}, { state: "forged" }],
    ["a state of another Provider", { provider: "simkl" }, {}],
  ])("creates nothing for %s", async (_, stateOverrides, body) => {
    useOAuthProvider();
    seedState(null, stateOverrides);
    const before = db.getTable("accounts").length;

    const res = await complete(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "expired" });
    expect(requests).toEqual([]);
    expect(db.getTable("connections")).toEqual([]);
    expect(db.getTable("accounts")).toHaveLength(before);
  });

  it("creates no Account when the token exchange fails", async () => {
    useOAuthProvider();
    seedState(null);
    serveToken({ error: "invalid_grant" }, 400);
    const before = db.getTable("accounts").length;

    const res = await complete();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "failed" });
    expect(db.getTable("accounts")).toHaveLength(before);
    expect(db.getTable("connections")).toEqual([]);
  });

  it("does not exchange the code when the Provider was turned off meanwhile", async () => {
    useOAuthProvider();
    seedState(accountId);
    vi.stubEnv("DISABLED_PROVIDERS", "trakt");

    const res = await complete();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "unavailable" });
    expect(requests).toEqual([]);
    expect(db.getTable("connections")).toEqual([]);
  });

  it("reports a failed token exchange", async () => {
    useOAuthProvider();
    seedState(accountId);
    serveToken({ error: "invalid_grant" }, 400);

    const res = await complete();

    expect(res.status).toBe(502);
    expect(db.getTable("connections")).toEqual([]);
  });
});
