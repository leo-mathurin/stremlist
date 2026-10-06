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
import {
  ConnectionExpiredError,
  deleteConnection,
  getConnectionAccess,
  listConnections,
  saveConnection,
} from "../connections";

const MINUTE = 60_000;

function connectionRow() {
  const row = db.getTable("connections").at(0);
  if (!row) throw new Error("no connection row");
  return row;
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
    const expiresAt = new Date(Date.now() + 60 * MINUTE);

    await saveConnection(
      accountId,
      "trakt",
      {
        accessToken: "plain-access",
        refreshToken: "plain-refresh",
        expiresAt,
        scope: "public",
      },
      "leo",
    );

    const row = connectionRow();
    expect(JSON.stringify(db.tables)).not.toContain("plain-access");
    expect(JSON.stringify(db.tables)).not.toContain("plain-refresh");
    expect(row).toMatchObject({
      account_id: accountId,
      provider: "trakt",
      provider_username: "leo",
      expires_at: expiresAt.toISOString(),
      scope: "public",
    });
    expect(decryptSecret(row.access_token as string)).toBe("plain-access");
    expect(decryptSecret(row.refresh_token as string)).toBe("plain-refresh");
  });

  it("replaces the Connection of the same Provider (one per Provider)", async () => {
    const tokens = (accessToken: string) => ({
      accessToken,
      refreshToken: null,
      expiresAt: null,
      scope: null,
    });

    await saveConnection(accountId, "trakt", tokens("first"), "leo");
    await saveConnection(accountId, "trakt", tokens("second"), "leo2");
    await saveConnection(accountId, "simkl", tokens("other"), null);

    expect(db.getTable("connections")).toHaveLength(2);
    const access = await getConnectionAccess(accountId, "trakt");
    expect(access?.username).toBe("leo2");
    await expect(access?.getAccessToken()).resolves.toBe("second");
  });
});

describe("listConnections and deleteConnection", () => {
  it("lists Connections without any token", async () => {
    seedConnection(accountId, "trakt", { username: "leo" });

    const list = await listConnections(accountId);

    expect(list).toEqual([
      {
        provider: "trakt",
        username: "leo",
        connectedAt: expect.any(String) as string,
      },
    ]);
  });

  it("revokes the token (best effort) and deletes the Connection", async () => {
    const revoke = vi.fn(() => Promise.reject(new Error("revoke failed")));
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
    seedConnection(accountId, "trakt", { accessToken: "to-revoke" });

    await deleteConnection(accountId, "trakt");

    expect(revoke).toHaveBeenCalledWith("to-revoke");
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

  it("uses a fresh token without refreshing", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "fresh",
      expiresAt: new Date(Date.now() + 60 * MINUTE),
    });

    const access = await getConnectionAccess(accountId, "trakt");

    await expect(access?.getAccessToken()).resolves.toBe("fresh");
    expect(oauthMocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("treats a token without an expiry as fresh", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "forever",
      expiresAt: null,
    });

    const access = await getConnectionAccess(accountId, "trakt");

    await expect(access?.getAccessToken()).resolves.toBe("forever");
  });

  it("refreshes a dying token under the lease and saves the new one", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    const newExpiry = new Date(Date.now() + 24 * 60 * MINUTE);
    oauthMocks.refreshTokens.mockResolvedValue({
      accessToken: "new",
      refreshToken: "new-refresh",
      expiresAt: newExpiry,
      scope: null,
    });

    const access = await getConnectionAccess(accountId, "trakt");
    const token = await access?.getAccessToken();

    expect(token).toBe("new");
    expect(oauthMocks.refreshTokens).toHaveBeenCalledExactlyOnceWith(
      "trakt",
      "old-refresh",
    );
    const row = connectionRow();
    expect(decryptSecret(row.access_token as string)).toBe("new");
    expect(decryptSecret(row.refresh_token as string)).toBe("new-refresh");
    expect(row.expires_at).toBe(newExpiry.toISOString());
    // The lease is released for the next refresh.
    expect(row.refresh_lease_token).toBeNull();
    expect(row.refresh_locked_until).toBe("1970-01-01T00:00:00.000Z");
    // The next call reuses the new token.
    await expect(access?.getAccessToken()).resolves.toBe("new");
    expect(oauthMocks.refreshTokens).toHaveBeenCalledOnce();
  });

  it("keeps the old refresh token when the Provider does not rotate it", async () => {
    seedConnection(accountId, "simkl", {
      refreshToken: "kept",
      expiresAt: new Date(Date.now() - MINUTE),
    });
    oauthMocks.refreshTokens.mockResolvedValue({
      accessToken: "new",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 60 * MINUTE),
      scope: null,
    });

    const access = await getConnectionAccess(accountId, "simkl");
    await access?.getAccessToken();

    expect(decryptSecret(connectionRow().refresh_token as string)).toBe("kept");
  });

  it("refreshes only once when two requests need a new token at the same time", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      expiresAt: new Date(Date.now() + MINUTE),
    });
    const pending: (() => void)[] = [];
    oauthMocks.refreshTokens.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({
              accessToken: "new",
              refreshToken: "rotated",
              expiresAt: new Date(Date.now() + 60 * MINUTE),
              scope: null,
            });
          });
        }),
    );

    const first = await getConnectionAccess(accountId, "trakt");
    const second = await getConnectionAccess(accountId, "trakt");
    const firstToken = first?.getAccessToken();
    await vi.waitFor(() => {
      expect(oauthMocks.refreshTokens).toHaveBeenCalledOnce();
    });
    const secondToken = second?.getAccessToken();
    // The second request sees the lease taken and waits for the new token.
    await new Promise((resolve) => setTimeout(resolve, 50));
    pending.forEach((finish) => {
      finish();
    });

    await expect(firstToken).resolves.toBe("new");
    await expect(secondToken).resolves.toBe("new");
    expect(oauthMocks.refreshTokens).toHaveBeenCalledOnce();
  });

  it("waits for the other refresher's token when it does not get the lease", async () => {
    seedConnection(accountId, "trakt", {
      accessToken: "old",
      expiresAt: new Date(Date.now() + MINUTE),
    });
    // Another instance holds the lease and saves its new token meanwhile.
    rpcHandlers.set("claim_connection_refresh", () => {
      connectionRow().access_token = encryptSecret("from-other-instance");
      connectionRow().expires_at = new Date(
        Date.now() + 60 * MINUTE,
      ).toISOString();
      return { data: false, error: null };
    });

    const access = await getConnectionAccess(accountId, "trakt");

    await expect(access?.getAccessToken()).resolves.toBe("from-other-instance");
    expect(oauthMocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("keeps a still-valid token when the other refresher never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    seedConnection(accountId, "trakt", {
      accessToken: "still-valid",
      expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    rpcHandlers.set("claim_connection_refresh", () => ({
      data: false,
      error: null,
    }));

    const access = await getConnectionAccess(accountId, "trakt");
    const token = access?.getAccessToken();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(token).resolves.toBe("still-valid");
  });

  it("gives up with ConnectionExpiredError when the token expired and nobody refreshed it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    seedConnection(accountId, "trakt", {
      expiresAt: new Date(Date.now() - MINUTE),
    });
    rpcHandlers.set("claim_connection_refresh", () => ({
      data: false,
      error: null,
    }));

    const access = await getConnectionAccess(accountId, "trakt");
    const token = access?.getAccessToken();
    const settled = expect(token).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
  });

  it("throws ConnectionExpiredError for an expired token without a refresh token", async () => {
    seedConnection(accountId, "trakt", {
      refreshToken: null,
      expiresAt: new Date(Date.now() - MINUTE),
    });

    const access = await getConnectionAccess(accountId, "trakt");

    await expect(access?.getAccessToken()).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    expect(oauthMocks.refreshTokens).not.toHaveBeenCalled();
    // The lease is released even when the refresh fails.
    expect(connectionRow().refresh_lease_token).toBeNull();
  });

  it("throws ConnectionExpiredError when the Provider refuses the refresh", async () => {
    seedConnection(accountId, "trakt", {
      expiresAt: new Date(Date.now() - MINUTE),
    });
    oauthMocks.refreshTokens.mockRejectedValue(new Error("invalid_grant"));

    const access = await getConnectionAccess(accountId, "trakt");

    await expect(access?.getAccessToken()).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    expect(connectionRow().refresh_lease_token).toBeNull();
  });
});
