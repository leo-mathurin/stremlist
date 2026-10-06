import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_SORT_OPTION,
  IMDB_USER_ID_PATTERN,
} from "@stremlist/shared/constants";
import type { Tables } from "@stremlist/shared/database.types";
import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { supabase } from "../lib/supabase";
import { catalogSettingsSchema } from "./catalog-settings";
import { deleteCachedList } from "./list-cache";

type AccountRow = Tables<"accounts">;
type ListRow = Tables<"lists">;

export interface Account {
  id: string;
  legacyImdbUserId: string | null;
  movedAt: string | null;
  rpdbApiKey: string | null;
  actionsEnabled: boolean;
  actionProviders: ProviderId[];
  lastFetchedAt: string;
}

/**
 * How a request reached the Account. "legacy" requests come through a Legacy
 * alias (`ur…`), which anyone can guess, so they never read through a
 * Connection and never see the Account ID (ADR 0001).
 */
export interface AccountAccess {
  account: Account;
  via: "private" | "legacy";
}

export interface ListInput {
  id?: string;
  provider: ProviderId;
  sourceRef: string;
  catalogTitle?: string;
  sortOption: string;
  displayMode?: string;
  position: number;
  catalogSettings?: CatalogSettings;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    legacyImdbUserId: row.legacy_imdb_user_id,
    movedAt: row.moved_at,
    rpdbApiKey: row.rpdb_api_key,
    actionsEnabled: row.actions_enabled,
    actionProviders: row.action_providers.filter(isProviderId),
    lastFetchedAt: row.last_fetched_at,
  };
}

function mapList(row: ListRow): ConfigList | null {
  if (!isProviderId(row.provider)) return null;
  const settings = catalogSettingsSchema.safeParse(row.catalog_settings);
  return {
    id: row.id,
    provider: row.provider,
    sourceRef: row.source_ref,
    catalogTitle: row.catalog_title,
    sortOption: row.sort_option,
    displayMode: row.display_mode as ConfigList["displayMode"],
    position: row.position,
    ...(settings.success && Object.keys(settings.data).length > 0
      ? { catalogSettings: settings.data }
      : {}),
  };
}

/**
 * Find the Account behind an Addon URL key: a generated Account ID or a
 * Legacy alias. An Account that has a Legacy alias is reachable only through
 * that alias, so its internal ID is never a second way in.
 */
export async function resolveAccountKey(
  key: string,
): Promise<AccountAccess | null> {
  if (ACCOUNT_ID_PATTERN.test(key)) {
    const { data, error } = await supabase
      .from("accounts")
      .select("*")
      .eq("id", key)
      .maybeSingle();
    if (error || !data || data.legacy_imdb_user_id) return null;
    return { account: mapAccount(data), via: "private" };
  }
  if (IMDB_USER_ID_PATTERN.test(key)) {
    const { data, error } = await supabase
      .from("accounts")
      .select("*")
      .eq("legacy_imdb_user_id", key)
      .maybeSingle();
    if (error || !data) return null;
    return { account: mapAccount(data), via: "legacy" };
  }
  return null;
}

/**
 * Old installs pointed Stremio at `/ur…/manifest.json` directly. Keep that
 * working: the first manifest request creates a legacy Account whose only
 * List is the IMDb watchlist of that user.
 */
export async function ensureLegacyAccount(
  imdbUserId: string,
): Promise<AccountAccess> {
  const existing = await resolveAccountKey(imdbUserId);
  if (existing) {
    await supabase
      .from("accounts")
      .update({ is_active: true })
      .eq("id", existing.account.id);
    return existing;
  }

  const { data, error } = await supabase
    .from("accounts")
    .upsert(
      { legacy_imdb_user_id: imdbUserId, is_active: true },
      { onConflict: "legacy_imdb_user_id" },
    )
    .select("*")
    .single();
  if (error) {
    console.error(
      `Failed to create legacy account ${imdbUserId}:`,
      error.message,
    );
    throw error;
  }

  const { error: listError } = await supabase.from("lists").insert({
    account_id: data.id,
    provider: "imdb",
    source_ref: imdbUserId,
    catalog_title: "",
    sort_option: DEFAULT_SORT_OPTION,
    position: 0,
  });
  if (listError && listError.code !== "23505") {
    console.error(
      `Failed to seed the default list for ${imdbUserId}:`,
      listError.message,
    );
    throw listError;
  }

  return { account: mapAccount(data), via: "legacy" };
}

/** A new Account with a generated ID. Lists are saved separately. */
export async function createAccount(): Promise<Account> {
  const { data, error } = await supabase
    .from("accounts")
    .insert({ is_active: true })
    .select("*")
    .single();
  if (error) {
    console.error("Failed to create an account:", error.message);
    throw error;
  }
  return mapAccount(data);
}

export async function getAccountLists(
  accountId: string,
): Promise<ConfigList[]> {
  const { data, error } = await supabase
    .from("lists")
    .select("*")
    .eq("account_id", accountId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`Failed to fetch lists for ${accountId}:`, error.message);
    throw error;
  }
  return data.map(mapList).filter((list): list is ConfigList => !!list);
}

export async function getAccountListById(
  accountId: string,
  listId: string,
): Promise<ConfigList | null> {
  const { data, error } = await supabase
    .from("lists")
    .select("*")
    .eq("account_id", accountId)
    .eq("id", listId)
    .maybeSingle();
  if (error || !data) return null;
  return mapList(data);
}

/**
 * Replace an Account's Lists and settings in one transaction. Removed Lists
 * lose their cached Catalogs afterwards (R2 cannot join the transaction).
 */
export async function replaceAccountConfig(
  accountId: string,
  lists: ListInput[],
  rpdbApiKey: string | null,
  actions?: { enabled: boolean; providers: ProviderId[] },
): Promise<ConfigList[]> {
  const { data, error } = await supabase.rpc("replace_account_config", {
    p_account_id: accountId,
    p_rpdb_api_key: rpdbApiKey,
    p_lists: lists.map((list) => ({
      ...(list.id ? { id: list.id } : {}),
      provider: list.provider,
      source_ref: list.sourceRef,
      catalog_title: list.catalogTitle ?? "",
      sort_option: list.sortOption,
      display_mode: list.displayMode ?? "split",
      position: list.position,
      ...(list.catalogSettings === undefined
        ? {}
        : { catalog_settings: { ...list.catalogSettings } }),
    })),
    p_actions_enabled: actions?.enabled ?? null,
    p_action_providers: actions?.providers ?? null,
  });
  if (error) throw error;

  const result = data[0];
  const cleanup = await Promise.allSettled(
    result.deleted_ids.map((id) => deleteCachedList(id)),
  );
  cleanup.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      console.error(
        `Failed to delete the R2 cache of removed list ${result.deleted_ids[index]}:`,
        outcome.reason,
      );
    }
  });

  return (result.lists as ListRow[])
    .map(mapList)
    .filter((list): list is ConfigList => !!list);
}

/**
 * Give a Legacy alias install a private Addon URL: a new Account with a copy
 * of its Lists and settings (ADR 0001). The legacy Account stays as it is,
 * so the old install keeps serving its public Lists. A copy, not a move:
 * someone who guesses the `ur…` ID only gets their own copy.
 */
export async function createPrivateCopy(legacy: Account): Promise<Account> {
  const lists = await getAccountLists(legacy.id);
  const account = await createAccount();
  await replaceAccountConfig(
    account.id,
    lists.map((list, index) => ({
      provider: list.provider,
      sourceRef: list.sourceRef,
      catalogTitle: list.catalogTitle,
      sortOption: list.sortOption,
      displayMode: list.displayMode,
      position: index,
      catalogSettings: list.catalogSettings,
    })),
    legacy.rpdbApiKey,
  );
  await supabase
    .from("accounts")
    .update({ moved_at: new Date().toISOString() })
    .eq("id", legacy.id);
  return { ...account, rpdbApiKey: legacy.rpdbApiKey };
}

export async function markAccountFetched(
  accountId: string,
  field: "last_fetched_at" | "last_cache_served_at",
  at = new Date(),
): Promise<void> {
  await supabase
    .from("accounts")
    .update({ [field]: at.toISOString() })
    .eq("id", accountId);
}
