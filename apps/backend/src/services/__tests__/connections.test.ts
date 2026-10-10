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
import {
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
      "https://api.stremlist.test/oauth/trakt/callback",
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
      redirect_uri: "https://api.stremlist.test/oauth/trakt/callback",
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

    await saveConnection(
      accountId,
      "trakt",
      tokens("first"),
      "leo",
      "https://api.stremlist.test/oauth/trakt/callback",
    );
    await saveConnection(
      accountId,
      "trakt",
      tokens("second"),
      "leo2",
      "https://api.stremlist.test/oauth/trakt/callback",
    );
    await saveConnection(
      accountId,
      "simkl",
      tokens("other"),
      null,
      "https://api.stremlist.test/oauth/simkl/callback",
    );

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
        needsRenewalSince: null,
      },
    ]);
  });

  it("revokes the token (best effort) and deletes the Connection with what it read", async () => {
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
    const list = seedList(accountId, {
      provider: "trakt",
      source_ref: "me/watchlist",
      merged_sources: [
        { provider: "trakt", source_ref: "users/leo/watchlist" },
      ],
    });
    const other = seedAccount();
    const otherList = seedList(other.id, {
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
    db.insert("source_list_syncs", {
      account_id: accountId,
      provider: "trakt",
      source_ref: "me/watchlist",
      baseline_at: new Date().toISOString(),
      last_complete_sync_at: new Date().toISOString(),
      requires_connection: true,
    });

    await deleteConnection(accountId, "trakt", [
      { listId: list.id, sourceRef: "me/watchlist" },
      // Another Account's List is never touched.
      { listId: otherList.id, sourceRef: "me/watchlist" },
    ]);

    expect(revoke).toHaveBeenCalledWith("to-revoke");
    expect(db.getTable("connections")).toEqual([]);
    expect(db.getTable("source_list_syncs")).toEqual([]);
    expect(
      db
        .getTable("list_sync_status")
        .map((row) => [row.list_id, row.source_ref]),
    ).toEqual([
      [list.id, "users/leo/watchlist"],
      [otherList.id, "me/watchlist"],
    ]);
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
    // The same redirect URI as the authorization, whatever the origin now.
    expect(oauthMocks.refreshTokens).toHaveBeenCalledExactlyOnceWith(
      "trakt",
      "old-refresh",
      "https://api.stremlist.test/oauth/trakt/callback",
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

describe("Connections that need renewal", () => {
  it("marks the Connection when the Provider refuses the token refresh", async () => {
    seedConnection(accountId, "trakt", {
      expiresAt: new Date(Date.now() - MINUTE),
    });
    oauthMocks.refreshTokens.mockRejectedValue(new Error("invalid_grant"));
    const access = await getConnectionAccess(accountId, "trakt");

    await access?.getAccessToken().catch(() => undefined);

    // Any caller (a public read, an Action) sees it, not only List reads.
    expect((await listConnections(accountId))[0].needsRenewalSince).toEqual(
      expect.any(String),
    );
  });

  it("marks the Connection when it expired without a refresh token", async () => {
    seedConnection(accountId, "trakt", {
      refreshToken: null,
      expiresAt: new Date(Date.now() - MINUTE),
    });
    const access = await getConnectionAccess(accountId, "trakt");

    await access?.getAccessToken().catch(() => undefined);

    expect(connectionRow().needs_renewal_since).not.toBeNull();
  });

  it("clears the mark when a token refresh works", async () => {
    seedConnection(accountId, "trakt", {
      expiresAt: new Date(Date.now() - MINUTE),
    });
    connectionRow().needs_renewal_since = new Date().toISOString();
    oauthMocks.refreshTokens.mockResolvedValue({
      accessToken: "new",
      refreshToken: "new-refresh",
      expiresAt: new Date(Date.now() + 60 * MINUTE),
      scope: null,
    });
    const access = await getConnectionAccess(accountId, "trakt");

    await expect(access?.getAccessToken()).resolves.toBe("new");
    expect(connectionRow().needs_renewal_since).toBeNull();
  });

  it("does not mark a Connection authorized again after the refused read started", async () => {
    seedConnection(accountId, "trakt", { accessToken: "old" });
    const oldAccess = await getConnectionAccess(accountId, "trakt");

    await saveConnection(
      accountId,
      "trakt",
      { accessToken: "new", refreshToken: null, expiresAt: null, scope: null },
      "leo",
      "https://api.stremlist.test/oauth/trakt/callback",
    );
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
