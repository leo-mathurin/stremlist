import type { ProviderId } from "@stremlist/shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauthMocks = vi.hoisted(() => ({
  refreshTokens: vi.fn(),
}));

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});
vi.mock("../oauth", () => oauthMocks);
vi.mock("../../providers/registry", async () => {
  return await import("../../__tests__/helpers/mock-registry");
});

import {
  seedAccount,
  seedConnection,
  seedList,
  useTestEncryptionKey,
} from "../../__tests__/helpers/fixtures";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import {
  db,
  resetRpc,
  rpcHandlers,
} from "../../__tests__/helpers/mock-supabase";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { ConnectionExpiredError } from "../../providers/types";
import { isCurrentConnection } from "../connection-identity";
import {
  deleteConnection,
  getConnectionAccess,
  listConnections,
  saveConnection,
} from "../connections";
import type { OAuthTokens } from "../oauth";

const MINUTE = 60_000;
const inAnHour = () => new Date(Date.now() + 60 * MINUTE);
const ago = () => new Date(Date.now() - MINUTE);
const callbackUrl = (provider: ProviderId) =>
  `https://api.stremlist.test/oauth/${provider}/callback`;

function connectionRow() {
  const row = db.getTable("connections").at(0);
  if (!row) throw new Error("no connection row");
  return row;
}

function storedToken(column: "access_token" | "refresh_token") {
  return decryptSecret(connectionRow()[column] as string);
}

function tokens(
  accessToken: string,
  overrides: Partial<OAuthTokens> = {},
): OAuthTokens {
  return {
    accessToken,
    refreshToken: null,
    expiresAt: inAnHour(),
    scope: null,
    ...overrides,
  };
}

function save(
  accessToken: string,
  overrides: Partial<OAuthTokens> = {},
  username: string | null = "leo",
  provider: ProviderId = "trakt",
) {
  return saveConnection(
    accountId,
    provider,
    tokens(accessToken, overrides),
    username,
    callbackUrl(provider),
  );
}

async function accessToken(provider: ProviderId = "trakt") {
  return (await getConnectionAccess(accountId, provider))?.getAccessToken();
}

/** Another instance holds the refresh lease. */
function leaseTaken(onClaim: () => void = () => undefined) {
  rpcHandlers.set("claim_connection_refresh", () => {
    onClaim();
    return { data: false, error: null };
  });
}

function useRevokingTrakt(revoke: (token: string) => Promise<void>) {
  useFakeProvider(
    fakeAdapter("trakt", {
      oauth: {
        authorizeUrl: "https://trakt.example/authorize",
        tokenUrl: "https://trakt.example/token",
        clientId: () => "id",
        revoke,
      },
    }),
  );
}

let accountId = "";

beforeEach(() => {
  db.reset();
  resetRpc();
  resetProviders();
  oauthMocks.refreshTokens.mockReset();
  useTestEncryptionKey();
  accountId = seedAccount().id;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("saveConnection", () => {
  it("stores tokens encrypted, never in plaintext", async () => {
    const expiresAt = inAnHour();

    await save("plain-access", {
      refreshToken: "plain-refresh",
      expiresAt,
      scope: "public",
    });

    expect(JSON.stringify(db.tables)).not.toContain("plain-access");
    expect(JSON.stringify(db.tables)).not.toContain("plain-refresh");
    expect(connectionRow()).toMatchObject({
      account_id: accountId,
      provider: "trakt",
      provider_username: "leo",
      expires_at: expiresAt.toISOString(),
      scope: "public",
      redirect_uri: callbackUrl("trakt"),
    });
    expect(storedToken("access_token")).toBe("plain-access");
    expect(storedToken("refresh_token")).toBe("plain-refresh");
  });

  it("replaces the Connection of the same Provider (one per Provider)", async () => {
    await save("first", { expiresAt: null });
    await save("second", { expiresAt: null }, "leo2");
    await save("other", { expiresAt: null }, null, "simkl");

    expect(db.getTable("connections")).toHaveLength(2);
    const access = await getConnectionAccess(accountId, "trakt");
    expect(access?.username).toBe("leo2");
    await expect(access?.getAccessToken()).resolves.toBe("second");
  });
});

describe("listConnections and deleteConnection", () => {
  it("lists Connections without any token", async () => {
    seedConnection(accountId, "trakt", { username: "leo" });

    expect(await listConnections(accountId)).toEqual([
      {
        provider: "trakt",
        username: "leo",
        connectedAt: expect.any(String) as string,
        needsRenewalSince: null,
      },
    ]);
  });

  it("revokes the token (best effort) and deletes the Connection with what it read", async () => {
    const revoke = vi.fn(() => Promise.reject(new Error("revoke failed")));
    useRevokingTrakt(revoke);
    seedConnection(accountId, "trakt", { accessToken: "to-revoke" });
    const list = seedList(accountId, {
      provider: "trakt",
      source_ref: "me/watchlist",
      merged_sources: [
        { provider: "trakt", source_ref: "users/leo/watchlist" },
      ],
    });
    const otherList = seedList(seedAccount().id, {
      provider: "trakt",
      source_ref: "me/watchlist",
    });
    for (const [listId, sourceRef] of [
      [list.id, "me/watchlist"],
      [list.id, "users/leo/watchlist"],
      [otherList.id, "me/watchlist"],
    ]) {
      db.insert("list_sync_status", {
        list_id: listId,
        provider: "trakt",
        source_ref: sourceRef,
        last_attempt_at: new Date().toISOString(),
      });
    }
    await deleteConnection(accountId, "trakt", [
      { listId: list.id, sourceRef: "me/watchlist" },
      // Another Account's List is never touched.
      { listId: otherList.id, sourceRef: "me/watchlist" },
    ]);

    expect(revoke).toHaveBeenCalledWith("to-revoke");
    expect(db.getTable("connections")).toEqual([]);
    expect(
      db
        .getTable("list_sync_status")
        .map((row) => [row.list_id, row.source_ref]),
    ).toEqual([
      [list.id, "users/leo/watchlist"],
      [otherList.id, "me/watchlist"],
    ]);
  });

  it("deletes the Connection of a turned-off Provider without calling it", async () => {
    const revoke = vi.fn(() => Promise.resolve());
    useRevokingTrakt(revoke);
    seedConnection(accountId, "trakt");
    process.env.DISABLED_PROVIDERS = "trakt";

    await deleteConnection(accountId, "trakt", []);

    expect(revoke).not.toHaveBeenCalled();
    expect(db.getTable("connections")).toEqual([]);
  });
});

describe("getConnectionAccess", () => {
  it("returns null without a Connection", async () => {
    await expect(getConnectionAccess(accountId, "trakt")).resolves.toBeNull();
  });

  it("returns null when the stored token cannot be decrypted", async () => {
    seedConnection(accountId, "trakt");
    process.env.CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
      "base64",
    );

    await expect(getConnectionAccess(accountId, "trakt")).resolves.toBeNull();
  });

  it.each([
    ["a fresh token", inAnHour()],
    ["a token without an expiry", null],
  ])("uses %s without refreshing", async (_, expiresAt) => {
    seedConnection(accountId, "trakt", { accessToken: "fresh", expiresAt });

    await expect(accessToken()).resolves.toBe("fresh");
    expect(oauthMocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("refreshes a dying token under the lease and saves the new one", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    const newExpiry = new Date(Date.now() + 24 * 60 * MINUTE);
    oauthMocks.refreshTokens.mockResolvedValue(
      tokens("new", { refreshToken: "new-refresh", expiresAt: newExpiry }),
    );

    const access = await getConnectionAccess(accountId, "trakt");
    if (!access) throw new Error("Expected seeded Connection");
    const identity = access.identity;

    expect(await access.getAccessToken()).toBe("new");
    expect(access.identity).toEqual(identity);
    expect(await isCurrentConnection(identity)).toBe(true);
    // The same redirect URI as the authorization, whatever the origin now.
    expect(oauthMocks.refreshTokens).toHaveBeenCalledExactlyOnceWith(
      "trakt",
      "old-refresh",
      callbackUrl("trakt"),
    );
    expect(storedToken("access_token")).toBe("new");
    expect(storedToken("refresh_token")).toBe("new-refresh");
    const row = connectionRow();
    expect(row.expires_at).toBe(newExpiry.toISOString());
    // The lease is released for the next refresh.
    expect(row.refresh_lease_token).toBeNull();
    expect(row.refresh_locked_until).toBe("1970-01-01T00:00:00.000Z");
    // The next call reuses the new token.
    await expect(access.getAccessToken()).resolves.toBe("new");
    expect(oauthMocks.refreshTokens).toHaveBeenCalledOnce();
  });

  it("invalidates old private data on reconnect even for the same user and token", async () => {
    await save("same-token", { expiresAt: null });
    const access = await getConnectionAccess(accountId, "trakt");
    if (!access) throw new Error("Expected seeded Connection");
    const identity = access.identity;

    await save("same-token", { expiresAt: null });
    expect(await isCurrentConnection(identity)).toBe(false);
    const reconnected = await getConnectionAccess(accountId, "trakt");
    expect(reconnected?.identity).not.toEqual(identity);
  });

  it("keeps a new authorization saved while an older refresh was in flight", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: ago(),
    });
    oauthMocks.refreshTokens.mockImplementation(async () => {
      // The user connects again (maybe as another Trakt user) meanwhile.
      await save(
        "reconnected",
        { refreshToken: "reconnected-refresh" },
        "other",
      );
      return tokens("refreshed-old", { refreshToken: "refreshed-old-refresh" });
    });

    await expect(accessToken()).resolves.toBe("reconnected");
    expect(storedToken("access_token")).toBe("reconnected");
    expect(storedToken("refresh_token")).toBe("reconnected-refresh");
    expect(connectionRow().provider_username).toBe("other");
  });

  it("keeps the old refresh token when the Provider does not rotate it", async () => {
    seedConnection(accountId, "simkl", {
      refreshToken: "kept",
      expiresAt: ago(),
    });
    oauthMocks.refreshTokens.mockResolvedValue(tokens("new"));

    await accessToken("simkl");

    expect(storedToken("refresh_token")).toBe("kept");
  });

  it("refreshes only once when two requests need a new token at the same time", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      expiresAt: new Date(Date.now() + MINUTE),
    });
    const refreshed = Promise.withResolvers<OAuthTokens>();
    oauthMocks.refreshTokens.mockReturnValue(refreshed.promise);

    const first = await getConnectionAccess(accountId, "trakt");
    const second = await getConnectionAccess(accountId, "trakt");
    const firstToken = first?.getAccessToken();
    await vi.waitFor(() => {
      expect(oauthMocks.refreshTokens).toHaveBeenCalledOnce();
    });
    const secondToken = second?.getAccessToken();
    // The second request sees the lease taken and waits for the new token.
    await new Promise((resolve) => setTimeout(resolve, 50));
    refreshed.resolve(tokens("new", { refreshToken: "rotated" }));

    await expect(firstToken).resolves.toBe("new");
    await expect(secondToken).resolves.toBe("new");
    expect(oauthMocks.refreshTokens).toHaveBeenCalledOnce();
  });

  it("waits for the other refresher's token when it does not get the lease", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      expiresAt: new Date(Date.now() + MINUTE),
    });
    // The other instance saves its new token meanwhile.
    leaseTaken(() => {
      connectionRow().access_token = encryptSecret("from-other-instance");
      connectionRow().expires_at = inAnHour().toISOString();
    });

    await expect(accessToken()).resolves.toBe("from-other-instance");
    expect(oauthMocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("keeps a still-valid token when the other refresher never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    seedConnection(accountId, "trakt", {
      accessToken: "still-valid",
      expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    leaseTaken();

    const token = accessToken();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(token).resolves.toBe("still-valid");
  });

  it("gives up with ConnectionExpiredError when the token expired and nobody refreshed it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    seedConnection(accountId, "trakt", { expiresAt: ago() });
    leaseTaken();

    const settled = expect(accessToken()).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
  });

  it.each([
    ["for an expired token without a refresh token", null],
    ["when the Provider refuses the refresh", "refresh-token"],
  ])(
    "throws ConnectionExpiredError %s and marks the Connection for renewal",
    async (_, refreshToken) => {
      seedConnection(accountId, "trakt", { refreshToken, expiresAt: ago() });
      oauthMocks.refreshTokens.mockRejectedValue(new Error("invalid_grant"));

      await expect(accessToken()).rejects.toBeInstanceOf(
        ConnectionExpiredError,
      );
      expect(oauthMocks.refreshTokens).toHaveBeenCalledTimes(
        refreshToken ? 1 : 0,
      );
      // The lease is released even when the refresh fails.
      expect(connectionRow().refresh_lease_token).toBeNull();
      // Any caller (a public read, an Action) sees it, not only List reads.
      expect((await listConnections(accountId))[0].needsRenewalSince).toEqual(
        expect.any(String),
      );
    },
  );
});

describe("Connections that need renewal", () => {
  it("clears the mark when a token refresh works", async () => {
    seedConnection(accountId, "trakt", { expiresAt: ago() });
    connectionRow().needs_renewal_since = new Date().toISOString();
    oauthMocks.refreshTokens.mockResolvedValue(
      tokens("new", { refreshToken: "new-refresh" }),
    );

    await expect(accessToken()).resolves.toBe("new");
    expect(connectionRow().needs_renewal_since).toBeNull();
  });

  it("does not mark a Connection authorized again after the refused read started", async () => {
    seedConnection(accountId, "trakt", { accessToken: "old" });
    const oldAccess = await getConnectionAccess(accountId, "trakt");

    await save("new", { expiresAt: null });
    await oldAccess?.reportRefused();

    expect(connectionRow().needs_renewal_since).toBeNull();
    const newAccess = await getConnectionAccess(accountId, "trakt");
    await newAccess?.reportRefused();
    expect(connectionRow().needs_renewal_since).not.toBeNull();
  });

  it("keeps the first time the Provider refused the Connection", async () => {
    seedConnection(accountId, "trakt");
    const access = await getConnectionAccess(accountId, "trakt");
    await access?.reportRefused();
    const first = connectionRow().needs_renewal_since;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await access?.reportRefused();

    expect(connectionRow().needs_renewal_since).toBe(first);
  });

  it("clears the mark for the tokens that worked only", async () => {
    seedConnection(accountId, "trakt", { accessToken: "old" });
    const oldAccess = await getConnectionAccess(accountId, "trakt");
    await oldAccess?.reportRefused();
    await oldAccess?.reportWorking();
    expect(connectionRow().needs_renewal_since).toBeNull();
  });
});
