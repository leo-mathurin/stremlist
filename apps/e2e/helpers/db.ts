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
import { E2E_USER_IDS } from "./test-data.js";
import { deleteCacheObjects, deleteConnectionObjects } from "./r2.js";

// Service-role client: bypasses RLS, used only to reset and inspect state
// between tests. Live tests bootstrap through the HTTP API; controlled catalog
// fixtures seed rows before the backend first reads them.
export const db = createClient<Database>(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

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
  options: { legacyImdbUserId?: string } = {},
): Promise<string> {
  const { data, error } = await db
    .from("accounts")
    .insert({
      legacy_imdb_user_id: options.legacyImdbUserId ?? null,
      is_active: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** A private Account with these Lists, in this order. Returns the IDs. */
export async function seedAccountWithLists(
  lists: Omit<SeedListInput, "position">[],
): Promise<{ accountId: string; listIds: string[] }> {
  const accountId = await seedAccount();
  const listIds: string[] = [];
  for (const [position, list] of lists.entries()) {
    listIds.push(await seedList(accountId, { ...list, position }));
  }
  return { accountId, listIds };
}

export interface SeedListInput {
  provider?: ProviderId;
  sourceRef: string;
  catalogTitle: string;
  position: number;
  sortOption?: string;
  displayMode?: "split" | "movie" | "series";
  catalogSettings?: CatalogSettings;
  /** More Source lists of a merged List, after the first one. */
  mergedSources?: ListSource[];
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
    })),
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
    },
    { onConflict: "account_id,provider" },
  );
  if (error) throw error;
}

export async function getConnectionRow(accountId: string, provider: string) {
  const { data, error } = await db
    .from("connections")
    .select(
      "provider, provider_username, expires_at, access_token, redirect_uri",
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
