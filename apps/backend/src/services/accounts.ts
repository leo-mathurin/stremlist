import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_SORT_OPTION,
  IMDB_USER_ID_PATTERN,
} from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { Tables } from "@stremlist/shared/database.types";
import { listRequiresConnection } from "@stremlist/shared/list-merge";
import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import type { AddonAccess, ConfigList } from "@stremlist/shared/stremio.types";
import { supabase } from "../lib/supabase";
import { deleteCachedList } from "./list-cache";
import { mapList, toStoredSources } from "./list-rows";
import { unusedSourceCaches } from "./merged-lists";

type AccountRow = Tables<"accounts">;
type ListRow = Tables<"lists">;

export interface Account {
  id: string;
  legacyImdbUserId: string | null;
  movedAt: string | null;
  rpdbApiKey: string | null;
  actionsEnabled: boolean;
  actionProviders: ProviderId[];
  /** Whether the manifest offers the "New titles" catalog (ADR 0007). */
  newTitlesCatalog: boolean;
  lastFetchedAt: string;
}

/**
 * How a request reached the Account. "legacy" requests come through a Legacy
 * alias (`ur…`), which anyone can guess, so they never read through a
 * Connection and never see the Account ID (ADR 0001).
 */
export interface AccountAccess {
  account: Account;
  via: AddonAccess;
}

/**
 * The Lists that a request may see. A Legacy alias can be guessed, so it
 * never sees the Lists that only a Connection can read.
 */
export function visibleLists(
  { via }: AccountAccess,
  lists: ConfigList[],
): ConfigList[] {
  return via === "private"
    ? lists
    : lists.filter((list) => !listRequiresConnection(list));
}

export interface ListInput {
  id?: string;
  provider: ProviderId;
  sourceRef: string;
  catalogTitle?: string;
  sortOption: string;
  displayMode: DisplayMode;
  position: number;
  catalogSettings?: CatalogSettings;
  mergedSources?: ListSource[];
  sourceLabel?: string;
  /**
   * The client omitted the merged Source lists, so `mergedSources` are the
   * saved ones: keep them, and refuse the save if another save changed them.
   */
  keptMergedSources?: boolean;
}

/** A concurrent save changed merged Source lists that this save kept. */
export class MergedSourcesChangedError extends Error {}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    legacyImdbUserId: row.legacy_imdb_user_id,
    movedAt: row.moved_at,
    rpdbApiKey: row.rpdb_api_key,
    actionsEnabled: row.actions_enabled,
    actionProviders: row.action_providers.filter(isProviderId),
    newTitlesCatalog: row.new_titles_catalog,
    lastFetchedAt: row.last_fetched_at,
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

/** The Account's Lists that the request may see (see visibleLists). */
export async function getVisibleLists(
  access: AccountAccess,
): Promise<ConfigList[]> {
  return visibleLists(access, await getAccountLists(access.account.id));
}

/** One List of the Account, if the request may see it (see visibleLists). */
export async function getVisibleListById(
  access: AccountAccess,
  listId: string,
): Promise<ConfigList | null> {
  const { data, error } = await supabase
    .from("lists")
    .select("*")
    .eq("account_id", access.account.id)
    .eq("id", listId)
    .maybeSingle();
  if (error || !data) return null;
  const list = mapList(data);
  return list && visibleLists(access, [list]).length > 0 ? list : null;
}

/** The stored form of submitted Lists (`p_lists` of the config RPCs). */
function toStoredLists(lists: ListInput[]) {
  return lists.map((list) => ({
    ...(list.id ? { id: list.id } : {}),
    provider: list.provider,
    source_ref: list.sourceRef,
    catalog_title: list.catalogTitle ?? "",
    sort_option: list.sortOption,
    display_mode: list.displayMode,
    position: list.position,
    ...(list.catalogSettings === undefined
      ? {}
      : { catalog_settings: { ...list.catalogSettings } }),
    ...(list.keptMergedSources
      ? { expected_merged_sources: toStoredSources(list.mergedSources ?? []) }
      : { merged_sources: toStoredSources(list.mergedSources ?? []) }),
    source_label: list.sourceLabel ?? null,
  }));
}

function mapLists(rows: unknown): ConfigList[] {
  return (rows as ListRow[])
    .map(mapList)
    .filter((list): list is ConfigList => !!list);
}

/**
 * Create an Account with a generated ID and its first Lists and settings, in
 * one transaction. Returns the private Account ID and the saved Lists.
 */
export async function createAccountWithConfig(
  lists: ListInput[],
  rpdbApiKey: string | null,
  settings: { newTitlesCatalog?: boolean } = {},
): Promise<{ accountId: string; lists: ConfigList[] }> {
  const { data, error } = await supabase.rpc("create_account_with_config", {
    p_rpdb_api_key: rpdbApiKey,
    p_lists: toStoredLists(lists),
    p_new_titles_catalog: settings.newTitlesCatalog ?? null,
  });
  if (error) {
    console.error("Failed to create an account:", error.message);
    throw error;
  }
  return { accountId: data[0].account_id, lists: mapLists(data[0].lists) };
}

/**
 * Replace an Account's Lists and settings in one transaction. The caches
 * that the save left unused (removed Lists and Source lists, compared with
 * the Lists that the transaction replaced) are deleted afterwards: R2 cannot
 * join the transaction.
 */
export async function replaceAccountConfig(
  accountId: string,
  lists: ListInput[],
  rpdbApiKey: string | null,
  /** Settings to change; an omitted one keeps its stored value. */
  settings: {
    actions?: { enabled: boolean; providers: ProviderId[] };
    newTitlesCatalog?: boolean;
  } = {},
): Promise<ConfigList[]> {
  const { actions, newTitlesCatalog } = settings;
  const { data, error } = await supabase.rpc("replace_account_config", {
    p_account_id: accountId,
    p_rpdb_api_key: rpdbApiKey,
    p_lists: toStoredLists(lists),
    p_actions_enabled: actions?.enabled ?? null,
    p_action_providers: actions?.providers ?? null,
    p_new_titles_catalog: newTitlesCatalog ?? null,
  });
  if (error) {
    // Raised by `replace_account_config` when kept Source lists changed.
    if (error.message === "Merged Source lists changed") {
      throw new MergedSourcesChangedError();
    }
    throw error;
  }

  const result = data[0];
  const saved = mapLists(result.lists);
  const unused = unusedSourceCaches(mapLists(result.previous_lists), saved);
  const cleanup = await Promise.allSettled(
    unused.map((key) => deleteCachedList(key)),
  );
  cleanup.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      console.error(
        `Failed to delete the unused R2 cache ${unused[index]}:`,
        outcome.reason,
      );
    }
  });

  return saved;
}

/**
 * Give a Legacy alias install a private Addon URL: a new Account with a copy
 * of its Lists and settings, and the Legacy alias marked as moved, in one
 * transaction (ADR 0001). The legacy Account keeps its Lists, so the old
 * install keeps serving its public Lists. A copy, not a move: someone who
 * guesses the `ur…` ID only gets their own copy. The detection history
 * stays with the legacy Account: the copy starts with its own Baseline.
 */
export async function createPrivateCopy(legacy: Account): Promise<Account> {
  const { data, error } = await supabase.rpc("copy_legacy_account", {
    p_legacy_id: legacy.id,
  });
  if (error) throw error;
  return mapAccount(data);
}

/**
 * Remember when the Account was last read from its Providers, or last served
 * from the cache. Never throws: a failed write is logged and must not fail
 * the read that it describes.
 */
export async function markAccountFetched(
  accountId: string,
  field: "last_fetched_at" | "last_cache_served_at",
  at = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({ [field]: at.toISOString() })
    .eq("id", accountId);
  if (error) {
    console.error(`Failed to update ${field} of ${accountId}:`, error.message);
  }
}
