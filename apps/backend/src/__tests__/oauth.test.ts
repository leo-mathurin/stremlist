import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const background = vi.hoisted(() => ({
  tasks: [] as (() => Promise<unknown>)[],
}));
vi.mock("../lib/background", () => ({
  scheduleBackgroundTask: (task: () => Promise<unknown>) =>
    background.tasks.push(task),
}));
vi.mock("../lib/r2", async () => await import("./helpers/mock-r2.js"));

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));

import app from "../index.js";
import { decryptSecret } from "../lib/crypto";
import type { OAuthConfig, ProviderAdapter } from "../providers/types";
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
} from "./helpers/fixtures.js";
import { r2Objects } from "./helpers/mock-r2.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const AUTHORIZE_URL = "https://trakt.example/oauth/authorize";
const TOKEN_URL = "https://api.trakt.example/oauth/token";

type ListConnectionSources = NonNullable<
  ProviderAdapter["listConnectionSources"]
>;

const fetchUsername = vi.fn<(accessToken: string) => Promise<string | null>>();

function useOAuthProvider(overrides: Partial<OAuthConfig> = {}) {
  useFakeProvider(
    fakeAdapter("trakt", {
      oauth: {
        authorizeUrl: AUTHORIZE_URL,
        tokenUrl: TOKEN_URL,
        clientId: () => "client-123",
        clientSecret: () => "secret-456",
        scopes: ["public", "private"],
        fetchUsername,
        ...overrides,
      },
    }),
  );
}

function stateRow() {
  const row = db.getTable("oauth_states").at(0);
  if (!row) throw new Error("no pending authorization");
  return row;
}

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

/** The configure page completes with the key that its start answered. */
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

const fetchMock = vi.fn<typeof fetch>();
let accountId = "";

beforeEach(() => {
  db.reset();
  r2Objects.clear();
  background.tasks.length = 0;
  resetRpc();
  resetProviders();
  useTestEncryptionKey();
  fetchUsername.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  accountId = seedAccount().id;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startAuthorization", () => {
  it("builds a PKCE authorize URL and remembers the verifier under the state", async () => {
    useOAuthProvider();

    const { authorizeUrl, browserKey } = await startAuthorization(
      accountId,
      "trakt",
      "https://api.stremlist.test",
    );
    const url = new URL(authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    const params = Object.fromEntries(url.searchParams);
    const row = stateRow();
    expect(params).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "https://api.stremlist.test/oauth/trakt/callback",
      state: row.state,
      code_challenge: createHash("sha256")
        .update(row.code_verifier as string)
        .digest("base64url"),
      code_challenge_method: "S256",
      scope: "public private",
    });
    expect(row).toMatchObject({ account_id: accountId, provider: "trakt" });
    expect(row.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // The verifier itself never leaves the server.
    expect(url.toString()).not.toContain(row.code_verifier as string);
    // Only the browser keeps its key; the server keeps a hash.
    expect(browserKey).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(url.toString()).not.toContain(browserKey);
    expect(row.browser_key_hash).toBe(
      createHash("sha256").update(browserKey).digest("base64url"),
    );
    const ttl = Date.parse(row.expires_at as string) - Date.now();
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
    useOAuthProvider({ clientId: () => undefined });

    await expect(
      startAuthorization(accountId, "trakt", "https://api.stremlist.test"),
    ).rejects.toBeInstanceOf(OAuthNotConfiguredError);
    expect(db.getTable("oauth_states")).toEqual([]);
  });

  it("prefers BACKEND_PUBLIC_URL for the redirect URI", async () => {
    useOAuthProvider();
    process.env.BACKEND_PUBLIC_URL = "https://api.stremlist.com/";
    try {
      const res = await app.request(`/${accountId}/connections/trakt/start`, {
        method: "POST",
      });
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };

      expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
        "https://api.stremlist.com/oauth/trakt/callback",
      );
      expect(redirectUri("trakt", "https://api.stremlist.com")).toBe(
        "https://api.stremlist.com/oauth/trakt/callback",
      );
    } finally {
      delete process.env.BACKEND_PUBLIC_URL;
    }
  });
});

describe("POST /:accountId/connections/:provider/start", () => {
  it("answers the authorize URL for a private Account", async () => {
    useOAuthProvider();

    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      authorizeUrl: string;
      browserKey: string;
    };
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
    useOAuthProvider({ clientId: () => undefined });

    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
  });

  it("refuses a turned-off Provider", async () => {
    useOAuthProvider();
    process.env.DISABLED_PROVIDERS = "trakt";

    const res = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
  });
});

describe("GET /:accountId/connections/:provider/sources", () => {
  it("lists the user's own lists through the Connection", async () => {
    const listConnectionSources = vi.fn<ListConnectionSources>(() =>
      Promise.resolve([
        {
          ref: "me/lists/42",
          kind: "list",
          label: "Horror",
          defaultDisplayMode: "split",
        },
      ]),
    );
    useFakeProvider(fakeAdapter("trakt", { listConnectionSources }));
    seedConnection(accountId, "trakt");

    const res = await app.request(`/${accountId}/connections/trakt/sources`);
    const body = (await res.json()) as { sources: { ref: string }[] };

    expect(body.sources.map((source) => source.ref)).toContain("me/lists/42");
    expect(listConnectionSources).toHaveBeenCalledOnce();
  });

  it("does not call a turned-off Provider", async () => {
    const listConnectionSources = vi.fn<ListConnectionSources>(() =>
      Promise.resolve([]),
    );
    useFakeProvider(fakeAdapter("trakt", { listConnectionSources }));
    seedConnection(accountId, "trakt");
    process.env.DISABLED_PROVIDERS = "trakt";

    const res = await app.request(`/${accountId}/connections/trakt/sources`);

    expect(res.status).toBe(200);
    expect(listConnectionSources).not.toHaveBeenCalled();
  });
});

describe("OAuth login CSRF", () => {
  async function attackerStart() {
    // The attacker starts a connect on their own Account and sends the
    // Provider consent link to a victim.
    const start = await app.request(`/${accountId}/connections/trakt/start`, {
      method: "POST",
    });
    const { authorizeUrl, browserKey } = (await start.json()) as {
      authorizeUrl: string;
      browserKey: string;
    };
    fetchMock.mockResolvedValue(Response.json({ access_token: "victim" }));
    fetchUsername.mockResolvedValue("victim");
    return {
      state: new URL(authorizeUrl).searchParams.get("state") ?? "",
      browserKey,
    };
  }

  it("links nothing when the consent link is opened in another browser", async () => {
    useOAuthProvider();
    const { state } = await attackerStart();

    // The victim approves: the Provider sends the victim's browser, which
    // never started this connect, back with a code.
    const res = await callback({ code: "victim-code", state });
    for (const task of background.tasks.splice(0)) await task();

    expect(redirectParams(res).params.connected).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getTable("connections")).toEqual([]);
  });

  it("refuses a completion with the key of another browser", async () => {
    useOAuthProvider();
    const { state } = await attackerStart();

    // The victim's page has no key for this authorization, or its own.
    const res = await complete({
      state,
      code: "victim-code",
      browserKey: "victim-browser-key",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "expired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getTable("connections")).toEqual([]);
    // A wrong key does not consume the authorization.
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
    expect(fetchMock).not.toHaveBeenCalled();
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
      fetchMock.mockResolvedValue(Response.json({ access_token: "renewed" }));
      fetchUsername.mockResolvedValue(username);

      const response = await complete();
      expect(await response.json()).toMatchObject({ ok: true, accountId });
      for (const task of background.tasks.splice(0)) await task();

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
    fetchMock.mockResolvedValue(
      Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 7200,
        scope: "public",
      }),
    );
    fetchUsername.mockResolvedValue("leo");

    const res = await complete();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accountId, created: false });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(
      Object.fromEntries(new URLSearchParams(init?.body as string)),
    ).toEqual({
      client_id: "client-123",
      client_secret: "secret-456",
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-xyz",
      redirect_uri: "http://localhost/oauth/trakt/callback",
    });
    expect(new Headers(init?.headers).get("User-Agent")).toMatch(
      /^Stremlist\//,
    );
    expect(fetchUsername).toHaveBeenCalledWith("access-1");

    const [row] = db.getTable("connections");
    expect(row).toMatchObject({
      account_id: accountId,
      provider: "trakt",
      provider_username: "leo",
      scope: "public",
      // Kept for refreshes, which must send the same redirect URI.
      redirect_uri: "http://localhost/oauth/trakt/callback",
    });
    expect(decryptSecret(row.access_token as string)).toBe("access-1");
    expect(decryptSecret(row.refresh_token as string)).toBe("refresh-1");
    expect(JSON.stringify(row)).not.toContain("access-1");
    // The state is single use.
    expect(db.getTable("oauth_states")).toEqual([]);
  });

  it("still connects when the username cannot be fetched", async () => {
    useOAuthProvider();
    seedState(accountId);
    fetchMock.mockResolvedValue(Response.json({ access_token: "access-1" }));
    fetchUsername.mockRejectedValue(new Error("rate limited"));

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
    fetchMock.mockResolvedValue(Response.json({ access_token: "access-1" }));
    fetchUsername.mockResolvedValue("leo");
    const before = db.getTable("accounts").length;

    const res = await complete({
      setup: {
        rpdbApiKey: "rpdb",
        lists: [
          {
            // An ID from another Account does not apply to a new one.
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
    const body = (await res.json()) as { accountId: string; created: boolean };
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
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getTable("connections")).toEqual([]);
    expect(db.getTable("accounts")).toHaveLength(before);
  });

  it("creates no Account when the token exchange fails", async () => {
    useOAuthProvider();
    seedState(null);
    fetchMock.mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
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
    process.env.DISABLED_PROVIDERS = "trakt";

    const res = await complete();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getTable("connections")).toEqual([]);
  });

  it("reports a failed token exchange", async () => {
    useOAuthProvider();
    seedState(accountId);
    fetchMock.mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    const res = await complete();

    expect(res.status).toBe(502);
    expect(db.getTable("connections")).toEqual([]);
  });
});
