import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { supabase } from "../lib/supabase";
import { getProvider } from "../providers/registry";
import type { ConnectionAccess } from "../providers/types";
import { ConnectionExpiredError } from "../providers/types";
import type { OAuthTokens } from "./oauth";
import { refreshTokens } from "./oauth";

/** Refresh a little before expiry so a request never uses a dying token. */
const REFRESH_MARGIN_MS = 10 * 60_000;
const REFRESH_LEASE_SECONDS = 30;
const LEASE_WAIT_ATTEMPTS = 6;
const LEASE_WAIT_MS = 500;

export { ConnectionExpiredError };

interface StoredConnection {
  accountId: string;
  provider: ProviderId;
  username: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  redirectUri: string;
  createdAt: string;
}

interface ConnectionRow {
  account_id: string;
  provider: string;
  provider_username: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  redirect_uri: string;
  created_at: string;
  needs_renewal_since: string | null;
}

function decode(row: ConnectionRow): StoredConnection | null {
  if (!isProviderId(row.provider)) return null;
  try {
    return {
      accountId: row.account_id,
      provider: row.provider,
      username: row.provider_username,
      accessToken: decryptSecret(row.access_token),
      refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      redirectUri: row.redirect_uri,
      createdAt: row.created_at,
    };
  } catch (error) {
    console.error(
      `Cannot decrypt the ${row.provider} connection of ${row.account_id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function readConnection(
  accountId: string,
  provider: ProviderId,
): Promise<StoredConnection | null> {
  const { data, error } = await supabase
    .from("connections")
    .select("*")
    .eq("account_id", accountId)
    .eq("provider", provider)
    .maybeSingle();
  if (error || !data) return null;
  return decode(data);
}

export async function listConnections(
  accountId: string,
): Promise<ConnectionSummary[]> {
  const { data, error } = await supabase
    .from("connections")
    .select("provider, provider_username, created_at, needs_renewal_since")
    .eq("account_id", accountId);
  if (error) {
    console.error(`Failed to list connections of ${accountId}:`, error.message);
    return [];
  }
  return (
    data as Pick<
      ConnectionRow,
      "provider" | "provider_username" | "created_at" | "needs_renewal_since"
    >[]
  )
    .filter((row) => isProviderId(row.provider))
    .map((row) => ({
      provider: row.provider as ProviderId,
      username: row.provider_username,
      connectedAt: row.created_at,
      needsRenewalSince: row.needs_renewal_since,
    }));
}

export async function saveConnection(
  accountId: string,
  provider: ProviderId,
  tokens: OAuthTokens,
  username: string | null,
  redirectUri: string,
): Promise<void> {
  const { error } = await supabase.from("connections").upsert(
    {
      account_id: accountId,
      provider,
      provider_username: username,
      redirect_uri: redirectUri,
      access_token: encryptSecret(tokens.accessToken),
      refresh_token: tokens.refreshToken
        ? encryptSecret(tokens.refreshToken)
        : null,
      expires_at: tokens.expiresAt?.toISOString() ?? null,
      scope: tokens.scope,
      // A new authorization replaces a refused one.
      needs_renewal_since: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id,provider" },
  );
  if (error) throw error;
}

async function updateTokens(
  accountId: string,
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<void> {
  const { error } = await supabase
    .from("connections")
    .update({
      access_token: encryptSecret(tokens.accessToken),
      // Keep the old refresh token when the Provider does not rotate it.
      ...(tokens.refreshToken
        ? { refresh_token: encryptSecret(tokens.refreshToken) }
        : {}),
      expires_at: tokens.expiresAt?.toISOString() ?? null,
      // The Provider accepted the refresh token, so the grant still works.
      needs_renewal_since: null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId)
    .eq("provider", provider);
  if (error) throw error;
}

/**
 * Remember that the Provider refused this Connection (revoked grant, refused
 * refresh), so the configure page asks the user to connect again. Keeps the
 * first time it happened.
 */
export async function markConnectionNeedsRenewal(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const { error } = await supabase
    .from("connections")
    .update({ needs_renewal_since: new Date().toISOString() })
    .eq("account_id", accountId)
    .eq("provider", provider)
    .is("needs_renewal_since", null);
  if (error) throw error;
}

/** A read through the Connection worked again: it needs no renewal. */
export async function clearConnectionRenewal(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const { error } = await supabase
    .from("connections")
    .update({ needs_renewal_since: null })
    .eq("account_id", accountId)
    .eq("provider", provider)
    .not("needs_renewal_since", "is", null);
  if (error) throw error;
}

export async function deleteConnection(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const stored = await readConnection(accountId, provider);
  if (stored) {
    try {
      await getProvider(provider).oauth?.revoke?.(stored.accessToken);
    } catch (error) {
      console.error(
        `Failed to revoke the ${provider} token of ${accountId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  const { error } = await supabase
    .from("connections")
    .delete()
    .eq("account_id", accountId)
    .eq("provider", provider);
  if (error) throw error;
}

function isFresh(connection: StoredConnection): boolean {
  return (
    !connection.expiresAt ||
    connection.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS
  );
}

function isUsable(connection: StoredConnection): boolean {
  return !connection.expiresAt || connection.expiresAt.getTime() > Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh under a lease: only one process refreshes a Connection at a time
 * (Trakt refresh tokens are single-use; Simkl cancels the previous access
 * token). The others wait for the new token, or keep the old one while it is
 * still valid.
 */
async function refreshUnderLease(
  connection: StoredConnection,
): Promise<StoredConnection> {
  const { accountId, provider } = connection;
  const leaseToken = randomUUID();
  const { data: claimed, error } = await supabase.rpc(
    "claim_connection_refresh",
    {
      p_account_id: accountId,
      p_provider: provider,
      p_lease_seconds: REFRESH_LEASE_SECONDS,
      p_lease_token: leaseToken,
    },
  );
  if (error) throw error;

  if (claimed) {
    try {
      // Another process may have refreshed between our read and the claim.
      const latest = (await readConnection(accountId, provider)) ?? connection;
      if (isFresh(latest)) return latest;
      if (!latest.refreshToken) throw new ConnectionExpiredError(provider);
      let tokens: OAuthTokens;
      try {
        tokens = await refreshTokens(
          provider,
          latest.refreshToken,
          latest.redirectUri,
        );
      } catch (refreshError) {
        console.error(
          `Refreshing the ${provider} connection of ${accountId} failed:`,
          refreshError instanceof Error ? refreshError.message : refreshError,
        );
        throw new ConnectionExpiredError(provider);
      }
      await updateTokens(accountId, provider, tokens);
      return {
        ...latest,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? latest.refreshToken,
        expiresAt: tokens.expiresAt,
      };
    } finally {
      await supabase.rpc("release_connection_refresh", {
        p_account_id: accountId,
        p_provider: provider,
        p_lease_token: leaseToken,
      });
    }
  }

  for (let attempt = 0; attempt < LEASE_WAIT_ATTEMPTS; attempt++) {
    await sleep(LEASE_WAIT_MS);
    const latest = await readConnection(accountId, provider);
    if (latest && isFresh(latest)) return latest;
  }
  if (isUsable(connection)) return connection;
  throw new ConnectionExpiredError(provider);
}

/**
 * Access to an Account's Connection with a Provider, or null if there is
 * none. Tokens are decrypted and refreshed only when a request needs them.
 */
export async function getConnectionAccess(
  accountId: string,
  provider: ProviderId,
): Promise<ConnectionAccess | null> {
  let current = await readConnection(accountId, provider);
  if (!current) return null;
  return {
    accountId,
    provider,
    username: current.username,
    async getAccessToken() {
      if (!current) throw new ConnectionExpiredError(provider);
      if (!isFresh(current)) current = await refreshUnderLease(current);
      return current.accessToken;
    },
  };
}
