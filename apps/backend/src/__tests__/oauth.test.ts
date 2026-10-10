import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import { decryptSecret } from "../lib/crypto";
import type { OAuthConfig, ProviderAdapter } from "../providers/types";
import {
  OAuthNotConfiguredError,
  redirectUri,
  startAuthorization,
} from "../services/oauth";
import {
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  useTestEncryptionKey,
} from "./helpers/fixtures.js";
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

function seedState(
  accountId: string,
  overrides: { state?: string; expiresAt?: Date; provider?: string } = {},
) {
  db.insert("oauth_states", {
    state: overrides.state ?? "state-abc",
    account_id: accountId,
    provider: overrides.provider ?? "trakt",
    code_verifier: "verifier-xyz",
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

function redirectParams(response: Response) {
  const location = response.headers.get("Location");
  if (!location) throw new Error("not a redirect");
  const url = new URL(location);
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
}

const fetchMock = vi.fn<typeof fetch>();
let accountId = "";

beforeEach(() => {
  db.reset();
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

    const url = new URL(
      await startAuthorization(
        accountId,
        "trakt",
        "https://api.stremlist.test",
      ),
    );

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
    const body = (await res.json()) as { ok: boolean; authorizeUrl: string };
    expect(body.ok).toBe(true);
    expect(body.authorizeUrl.startsWith(AUTHORIZE_URL)).toBe(true);
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

describe("GET /oauth/:provider/callback", () => {
  it("exchanges the code, stores the encrypted Connection and returns to the configure page", async () => {
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

    const res = await callback({ code: "code-1", state: "state-abc" });

    expect(res.status).toBe(302);
    expect(redirectParams(res)).toEqual({
      path: "/configure",
      params: { account: accountId, connected: "trakt" },
    });

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

    const res = await callback({ code: "code-1", state: "state-abc" });

    expect(redirectParams(res).params.connected).toBe("trakt");
    expect(db.getTable("connections")[0]).toMatchObject({
      provider_username: null,
      refresh_token: null,
      expires_at: null,
    });
  });

  it("reports an expired authorization and deletes it", async () => {
    useOAuthProvider();
    seedState(accountId, { expiresAt: new Date(Date.now() - 1000) });

    const res = await callback({ code: "code-1", state: "state-abc" });

    expect(redirectParams(res).params).toEqual({
      connection_error: "expired",
      provider: "trakt",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getTable("oauth_states")).toEqual([]);
    expect(db.getTable("connections")).toEqual([]);
  });

  it("reports an unknown state without naming an Account", async () => {
    useOAuthProvider();
    seedState(accountId);

    const res = await callback({ code: "code-1", state: "forged" });

    expect(redirectParams(res).params).toEqual({
      connection_error: "expired",
      provider: "trakt",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // A forged state does not consume the real one.
    expect(db.getTable("oauth_states")).toHaveLength(1);
  });

  it("does not accept a state issued for another Provider", async () => {
    useOAuthProvider();
    seedState(accountId, { provider: "simkl" });

    const res = await callback({ code: "code-1", state: "state-abc" });

    expect(redirectParams(res).params.connection_error).toBe("expired");
    expect(db.getTable("connections")).toEqual([]);
  });

  it("reports a denied authorization and consumes the state", async () => {
    useOAuthProvider();
    seedState(accountId);

    const res = await callback({ error: "access_denied", state: "state-abc" });

    expect(redirectParams(res).params).toEqual({
      account: accountId,
      connection_error: "denied",
      provider: "trakt",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getTable("oauth_states")).toEqual([]);
  });

  it("reports a failed token exchange", async () => {
    useOAuthProvider();
    seedState(accountId);
    fetchMock.mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    const res = await callback({ code: "code-1", state: "state-abc" });

    expect(redirectParams(res).params).toEqual({
      account: accountId,
      connection_error: "failed",
      provider: "trakt",
    });
    expect(db.getTable("connections")).toEqual([]);
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
