import type { Tables } from "@stremlist/shared/database.types";
import type { ConnectionSource, ProviderId } from "@stremlist/shared/providers";
import { CONNECTION_SOURCES, isProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { supabase } from "../lib/supabase";
import { getProvider, isProviderEnabled } from "../providers/registry";
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
  /**
   * The stored ciphertext of the access token. It changes with every new
   * authorization and token refresh, so renewal marks written with it only
   * apply to the tokens that the request used.
   */
  sealedToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  redirectUri: string;
  createdAt: string;
}

function decode(row: Tables<"connections">): StoredConnection | null {
  if (!isProviderId(row.provider)) return null;
  try {
    return {
      accountId: row.account_id,
      provider: row.provider,
      username: row.provider_username,
      accessToken: decryptSecret(row.access_token),
      sealedToken: row.access_token,
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
  return data.flatMap((row) =>
    isProviderId(row.provider)
      ? [
          {
            provider: row.provider,
            username: row.provider_username,
            connectedAt: row.created_at,
            needsRenewalSince: row.needs_renewal_since,
          },
        ]
      : [],
  );
}

/**
 * Save a new authorization, encrypted. It replaces a refused one, and in the
 * same transaction the detection history of Connection-only Source lists
 * that belonged to another Provider user is forgotten (ADR 0007).
 */
export async function saveConnection(
  accountId: string,
  provider: ProviderId,
  tokens: OAuthTokens,
  username: string | null,
  redirectUri: string,
): Promise<void> {
  const { error } = await supabase.rpc("save_connection", {
    p_account_id: accountId,
    p_provider: provider,
    p_provider_username: username,
    p_access_token: encryptSecret(tokens.accessToken),
    p_refresh_token: tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : null,
    p_expires_at: tokens.expiresAt?.toISOString() ?? null,
    p_scope: tokens.scope,
    p_redirect_uri: redirectUri,
  });
  if (error) throw error;
}

async function updateTokens(
  accountId: string,
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<string> {
  const sealedToken = encryptSecret(tokens.accessToken);
  const { error } = await supabase
    .from("connections")
    .update({
      access_token: sealedToken,
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
  return sealedToken;
}

/**
 * Mark these tokens as refused by the Provider (revoked grant, refused
 * refresh), so the configure page asks the user to connect again, or clear
 * the mark after a read with them worked. Marking keeps the first time it
 * happened. Tokens replaced since (a new authorization, a refresh by another
 * request) are left alone. Never throws.
 */
async function setNeedsRenewal(
  connection: StoredConnection,
  refused: boolean,
): Promise<void> {
  const query = supabase
    .from("connections")
    .update({ needs_renewal_since: refused ? new Date().toISOString() : null })
    .eq("account_id", connection.accountId)
    .eq("provider", connection.provider)
    .eq("access_token", connection.sealedToken);
  const { error } = await (refused
    ? query.is("needs_renewal_since", null)
    : query.not("needs_renewal_since", "is", null));
  if (error) {
    console.error(
      `Failed to ${refused ? "mark" : "clear"} the renewal of the ${connection.provider} connection of ${connection.accountId}:`,
      error.message,
    );
  }
}

/**
 * Revoke the token (best effort), then delete the Connection in one
 * transaction with the detection history that belongs to it and the sync
 * statuses of `sources`, the Source lists on this Provider that were read
 * through it.
 */
export async function deleteConnection(
  accountId: string,
  provider: ProviderId,
  sources: { listId: string; sourceRef: string }[],
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
  const { error } = await supabase.rpc("delete_connection", {
    p_account_id: accountId,
    p_provider: provider,
    p_list_ids: sources.map((source) => source.listId),
    p_source_refs: sources.map((source) => source.sourceRef),
  });
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
      if (!latest.refreshToken) {
        await setNeedsRenewal(latest, true);
        throw new ConnectionExpiredError(provider);
      }
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
        await setNeedsRenewal(latest, true);
        throw new ConnectionExpiredError(provider);
      }
      const sealedToken = await updateTokens(accountId, provider, tokens);
      return {
        ...latest,
        accessToken: tokens.accessToken,
        sealedToken,
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
  await setNeedsRenewal(connection, true);
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
  const stored = await readConnection(accountId, provider);
  if (!stored) return null;
  let current = stored;
  return {
    accountId,
    provider,
    username: current.username,
    async getAccessToken() {
      if (!isFresh(current)) current = await refreshUnderLease(current);
      return current.accessToken;
    },
    reportRefused: () => setNeedsRenewal(current, true),
    reportWorking: () => setNeedsRenewal(current, false),
  };
}

/**
 * Every Source list that a Connection unlocks: the Provider's static ones,
 * then the user's own lists that the Provider lists (without the static
 * ones again). Without a Connection, or when the Provider is turned off,
 * only the static ones. A failed listing is logged and leaves the user's
 * own lists out.
 */
export async function connectionSources(
  accountId: string,
  provider: ProviderId,
): Promise<ConnectionSource[]> {
  const staticSources = CONNECTION_SOURCES[provider] ?? [];
  // The kill switch also stops the call that lists the user's own lists.
  const connection = isProviderEnabled(provider)
    ? await getConnectionAccess(accountId, provider)
    : null;
  if (!connection) return staticSources;
  let own: ConnectionSource[] = [];
  try {
    own =
      (await getProvider(provider).listConnectionSources?.(connection)) ?? [];
  } catch (error) {
    console.error(
      `Listing ${provider} sources for ${accountId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
  const seen = new Set(staticSources.map((source) => source.ref));
  return [...staticSources, ...own.filter((source) => !seen.has(source.ref))];
}
