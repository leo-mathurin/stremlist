import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { Database } from "@stremlist/shared/database.types";
import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  BACKEND_URL,
  CONNECTION_ENCRYPTION_KEY,
  RUN_STARTED_AT,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../env.js";
import { E2E_USER_IDS, PUBLIC_USER } from "./test-data.js";
import { deleteCacheObjects, deleteConnectionObjects } from "./r2.js";

// Service-role client: bypasses RLS, used only to reset and inspect state
// between tests. Live tests bootstrap through the HTTP API; controlled catalog
// fixtures seed rows before the backend first reads them. Specs use the named
// seeders and readers below, never the client itself.
const db = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * The Accounts that this run owns: the Legacy aliases of the E2E fixtures,
 * and every Account created since the run started (their IDs are generated,
 * also when the browser creates them).
 */
async function ownedAccountIds(): Promise<string[]> {
  const [legacy, created] = await Promise.all([
    db
      .from("accounts")
      .select("id")
      .in("legacy_imdb_user_id", [...E2E_USER_IDS]),
    db.from("accounts").select("id").gte("created_at", RUN_STARTED_AT),
  ]);
  for (const result of [legacy, created]) {
    if (result.error) {
      throw new Error(`resetDb account lookup failed: ${result.error.message}`);
    }
  }
  return [...new Set([...legacy.data!, ...created.data!].map((row) => row.id))];
}

/** Delete this run's Accounts. Foreign-key cascades remove their data. */
export async function resetDb(): Promise<void> {
  const accountIds = await ownedAccountIds();
  if (accountIds.length === 0) return;

  const { data: lists, error: listError } = await db
    .from("lists")
    .select("id")
    .in("account_id", accountIds);
  if (listError) {
    throw new Error(`resetDb list lookup failed: ${listError.message}`);
  }

  await deleteCacheObjects(lists.map((list) => list.id));
  await deleteConnectionObjects(accountIds);

  const { error } = await db.from("accounts").delete().in("id", accountIds);
  if (error) throw new Error(`resetDb failed: ${error.message}`);
}

/** Rewind an Account's last_fetched_at so the refresh cooldown does not apply. */
export async function clearRefreshCooldown(accountId: string): Promise<void> {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { error } = await db
    .from("accounts")
    .update({ last_fetched_at: past })
    .eq("id", accountId);
  if (error) throw new Error(`clearRefreshCooldown failed: ${error.message}`);
}

/**
 * Insert an Account without the HTTP API, so no save-triggered prewarm reads
 * a Provider. With `legacyImdbUserId` it is a Legacy alias install.
 */
export async function seedAccount(
  options: {
    legacyImdbUserId?: string;
    newTitlesCatalog?: boolean;
    /** Actions on, with these Providers in this order. */
    actions?: ProviderId[];
  } = {},
): Promise<string> {
  const { data, error } = await db
    .from("accounts")
    .insert({
      legacy_imdb_user_id: options.legacyImdbUserId ?? null,
      is_active: true,
      new_titles_catalog: options.newTitlesCatalog ?? false,
      ...(options.actions && {
        actions_enabled: true,
        action_providers: options.actions,
      }),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** A private Account whose only List is one IMDb Source list. */
export async function seedImdbAccount(
  sourceRef: string = PUBLIC_USER,
  catalogTitle = "",
): Promise<{ accountId: string; listId: string }> {
  const {
    accountId,
    listIds: [listId],
  } = await seedAccountWithLists([
    { sourceRef, catalogTitle, displayMode: "split" },
  ]);
  return { accountId, listId };
}

/** A private Account with these Lists, in this order. Returns the IDs. */
export async function seedAccountWithLists(
  lists: Omit<SeedListInput, "position">[],
  options: { newTitlesCatalog?: boolean } = {},
): Promise<{ accountId: string; listIds: string[] }> {
  const accountId = await seedAccount(options);
  const listIds: string[] = [];
  for (const [position, list] of lists.entries()) {
    listIds.push(await seedList(accountId, { ...list, position }));
  }
  return { accountId, listIds };
}

interface SeedListInput {
  provider?: ProviderId;
  sourceRef: string;
  catalogTitle: string;
  position: number;
  sortOption?: string;
  displayMode?: "split" | "movie" | "series";
  catalogSettings?: CatalogSettings;
  /** More Source lists of a merged List, after the first one. */
  mergedSources?: ListSource[];
  /** The label of the first Source list, when it was merged in earlier. */
  sourceLabel?: string;
}

/** Add a controlled List row without a save-triggered external prewarm. */
export async function seedList(
  accountId: string,
  list: SeedListInput,
): Promise<string> {
  const id = randomUUID();
  const { error } = await db.from("lists").insert({
    id,
    account_id: accountId,
    provider: list.provider ?? "imdb",
    source_ref: list.sourceRef,
    catalog_title: list.catalogTitle,
    sort_option: list.sortOption ?? "added_at-asc",
    display_mode: list.displayMode ?? "movie",
    position: list.position,
    catalog_settings: { ...(list.catalogSettings ?? {}) },
    merged_sources: (list.mergedSources ?? []).map((source) => ({
      provider: source.provider,
      source_ref: source.sourceRef,
      ...(source.label ? { label: source.label } : {}),
    })),
    source_label: list.sourceLabel ?? null,
  });
  if (error) throw error;
  return id;
}

/** The backend's "v1:" AES-256-GCM token format (apps/backend/src/lib/crypto.ts). */
function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(CONNECTION_ENCRYPTION_KEY, "base64"),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

/** Store a Connection as the OAuth callback would, with synthetic tokens. */
export async function seedConnection(
  accountId: string,
  provider: ProviderId,
  options: {
    username?: string | null;
    accessToken?: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    /** The callback of the authorization; refreshes send it again. */
    redirectUri?: string;
    /** Since when the Provider refuses it (the renewal mark). */
    needsRenewalSince?: Date;
  } = {},
): Promise<void> {
  const refreshToken =
    options.refreshToken === undefined
      ? "fixture-refresh-token"
      : options.refreshToken;
  const { error } = await db.from("connections").upsert(
    {
      account_id: accountId,
      provider,
      provider_username:
        options.username === undefined ? "fixture-user" : options.username,
      redirect_uri:
        options.redirectUri ?? `${BACKEND_URL}/oauth/${provider}/callback`,
      access_token: encryptToken(options.accessToken ?? "fixture-access-token"),
      refresh_token: refreshToken ? encryptToken(refreshToken) : null,
      expires_at:
        options.expiresAt === undefined
          ? new Date(Date.now() + 24 * 60 * 60_000).toISOString()
          : (options.expiresAt?.toISOString() ?? null),
      ...(options.needsRenewalSince && {
        needs_renewal_since: options.needsRenewalSince.toISOString(),
      }),
    },
    { onConflict: "account_id,provider" },
  );
  if (error) throw error;
}

export async function getConnectionRow(accountId: string, provider: string) {
  const { data, error } = await db
    .from("connections")
    .select(
      "provider, provider_username, expires_at, access_token, redirect_uri, needs_renewal_since",
    )
    .eq("account_id", accountId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getAccountRow(accountId: string) {
  const { data, error } = await db
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getAccountByLegacyAlias(imdbUserId: string) {
  const { data, error } = await db
    .from("accounts")
    .select("*")
    .eq("legacy_imdb_user_id", imdbUserId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getListRows(accountId: string) {
  const { data, error } = await db
    .from("lists")
    .select("*")
    .eq("account_id", accountId)
    .order("position", { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * The detection history of one Source list (ADR 0007), without a refresh:
 * its synchronization row and its entries. An entry without `detectedAt` is
 * part of the Baseline.
 */
export async function seedDetectionHistory(
  accountId: string,
  source: { provider: ProviderId; sourceRef: string },
  sync: {
    baselineAt: string;
    lastSyncAt: string;
    /** The Provider user of the Connection, for Connection-only Source lists. */
    connectionUser?: string;
  },
  entries: { imdbId: string; detectedAt?: string }[],
): Promise<void> {
  const key = {
    account_id: accountId,
    provider: source.provider,
    source_ref: source.sourceRef,
  };
  const synced = await db.from("source_list_syncs").insert({
    ...key,
    baseline_at: sync.baselineAt,
    last_complete_sync_at: sync.lastSyncAt,
    requires_connection: sync.connectionUser !== undefined,
    connection_user: sync.connectionUser ?? null,
  });
  if (synced.error) throw synced.error;
  const inserted = await db.from("source_list_entries").insert(
    entries.map((entry) => ({
      ...key,
      entry_key: `imdb:${entry.imdbId}`,
      imdb_id: entry.imdbId,
      detected_at: entry.detectedAt ?? null,
    })),
  );
  if (inserted.error) throw inserted.error;
}

/** Store the sync status of a refresh at `at` that gave `titleCount` Titles. */
export async function seedSyncStatus(
  listId: string,
  provider: ProviderId,
  sourceRef: string,
  at: Date,
  titleCount: number,
): Promise<void> {
  const { error } = await db.from("list_sync_status").insert({
    list_id: listId,
    provider,
    source_ref: sourceRef,
    last_attempt_at: at.toISOString(),
    last_success_at: at.toISOString(),
    title_count: titleCount,
  });
  if (error) throw error;
}

export async function getSyncStatusRows(listId: string) {
  const { data, error } = await db
    .from("list_sync_status")
    .select("*")
    .eq("list_id", listId);
  if (error) throw error;
  return data;
}

/** Forget what the ID resolver cached for these external IDs. */
export async function clearResolverCache(
  namespace: string,
  externalIds: string[],
): Promise<void> {
  const { error } = await db
    .from("title_id_map")
    .delete()
    .eq("namespace", namespace)
    .in("external_id", externalIds);
  if (error) throw error;
}

/** What the ID resolver cached for these external IDs, by external ID. */
export async function getResolverRows(
  namespace: string,
  externalIds: string[],
) {
  const { data, error } = await db
    .from("title_id_map")
    .select("external_id, imdb_id, strategy, retry_after")
    .eq("namespace", namespace)
    .in("external_id", externalIds)
    .order("external_id");
  if (error) throw error;
  return data;
}

/** The synchronization rows (Baselines) of an Account's Source lists. */
export async function getSourceListSyncs(accountId: string) {
  const { data, error } = await db
    .from("source_list_syncs")
    .select("provider, source_ref, baseline_at")
    .eq("account_id", accountId)
    .order("provider");
  if (error) throw error;
  return data;
}

/** The detection entries of an Account's Source lists, by entry key. */
export async function getSourceListEntries(accountId: string) {
  const { data, error } = await db
    .from("source_list_entries")
    .select("*")
    .eq("account_id", accountId)
    .order("entry_key");
  if (error) throw error;
  return data;
}

/** The pending OAuth authorizations with this state. */
export async function getOAuthStates(state: string) {
  const { data, error } = await db
    .from("oauth_states")
    .select("provider")
    .eq("state", state);
  if (error) throw error;
  return data;
}
