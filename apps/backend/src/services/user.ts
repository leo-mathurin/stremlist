import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import { DEFAULT_SORT_OPTION } from "@stremlist/shared/constants";
import type { Tables } from "@stremlist/shared/database.types";
import type { ConfigWatchlist } from "@stremlist/shared/stremio.types";
import { supabase } from "../lib/supabase";
import { catalogSettingsSchema } from "./catalog-settings";
import { deleteCachedWatchlist } from "./watchlist-cache";

type User = Tables<"users">;
type UserWatchlist = Tables<"user_watchlists">;

interface UserConfigUpdateWatchlistRow {
  id?: string;
  imdbUserId: string;
  catalogTitle?: string;
  sortOption: string;
  displayMode?: string;
  position: number;
  catalogSettings?: CatalogSettings;
}

const DEFAULT_WATCHLIST_TITLE = "";

function mapWatchlistRow(row: UserWatchlist): ConfigWatchlist {
  const settings = catalogSettingsSchema.safeParse(row.catalog_settings);
  return {
    id: row.id,
    imdbUserId: row.imdb_user_id,
    catalogTitle: row.catalog_title,
    sortOption: row.sort_option,
    displayMode: row.display_mode as ConfigWatchlist["displayMode"],
    position: row.position,
    ...(settings.success && Object.keys(settings.data).length > 0
      ? { catalogSettings: settings.data }
      : {}),
  };
}

export async function getUser(imdbUserId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("imdb_user_id", imdbUserId)
    .single();

  if (error) {
    return null;
  }
  return data;
}

export async function ensureUser(imdbUserId: string): Promise<User> {
  const { data, error } = await supabase
    .from("users")
    .upsert(
      {
        imdb_user_id: imdbUserId,
        is_active: true,
        last_fetched_at: new Date().toISOString(),
      },
      { onConflict: "imdb_user_id" },
    )
    .select("*")
    .single();

  if (error) {
    console.error(`Failed to upsert user ${imdbUserId}:`, error.message);
    throw error;
  }

  await seedDefaultWatchlist(imdbUserId);

  return data;
}

async function seedDefaultWatchlist(ownerUserId: string): Promise<void> {
  const { data: existing, error: existingError } = await supabase
    .from("user_watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .limit(1);

  if (existingError) {
    console.error(
      `Failed to check existing watchlists for ${ownerUserId}:`,
      existingError.message,
    );
    throw existingError;
  }

  if (existing.length > 0) {
    return;
  }

  const { error } = await supabase.from("user_watchlists").insert({
    owner_user_id: ownerUserId,
    imdb_user_id: ownerUserId,
    catalog_title: DEFAULT_WATCHLIST_TITLE,
    sort_option: DEFAULT_SORT_OPTION,
    position: 0,
  });

  if (error) {
    console.error(
      `Failed to seed default watchlist for ${ownerUserId}:`,
      error.message,
    );
    throw error;
  }
}

export async function getUserWatchlists(
  ownerUserId: string,
): Promise<ConfigWatchlist[]> {
  const { data, error } = await supabase
    .from("user_watchlists")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    console.error(
      `Failed to fetch watchlists for ${ownerUserId}:`,
      error.message,
    );
    throw error;
  }

  return data.map(mapWatchlistRow);
}

export async function getUserWatchlistById(
  ownerUserId: string,
  watchlistId: string,
): Promise<ConfigWatchlist | null> {
  const { data, error } = await supabase
    .from("user_watchlists")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .eq("id", watchlistId)
    .single();

  if (error) {
    return null;
  }

  return mapWatchlistRow(data);
}

export async function replaceUserWatchlists(
  ownerUserId: string,
  watchlists: UserConfigUpdateWatchlistRow[],
  rpdbApiKey: string | null,
): Promise<ConfigWatchlist[]> {
  const { data, error } = await supabase.rpc("replace_user_config", {
    p_owner_user_id: ownerUserId,
    p_rpdb_api_key: rpdbApiKey,
    p_watchlists: watchlists.map((w) => ({
      ...(w.id ? { id: w.id } : {}),
      imdb_user_id: w.imdbUserId,
      catalog_title: w.catalogTitle ?? "",
      sort_option: w.sortOption,
      display_mode: w.displayMode ?? "split",
      position: w.position,
      ...(w.catalogSettings === undefined
        ? {}
        : { catalog_settings: { ...w.catalogSettings } }),
    })),
  });
  if (error) throw error;

  const result = data[0];
  // External cache deletion cannot participate in the database transaction.
  const cleanupResults = await Promise.allSettled(
    result.deleted_ids.map((id) => deleteCachedWatchlist(id)),
  );
  cleanupResults.forEach((cleanup, index) => {
    if (cleanup.status === "rejected") {
      console.error(
        `Failed to delete R2 cache for removed watchlist ${result.deleted_ids[index]}:`,
        cleanup.reason,
      );
    }
  });

  // The RPC aggregates complete user_watchlists rows from the same transaction.
  return (result.watchlists as UserWatchlist[]).map(mapWatchlistRow);
}

export async function getUserRpdbApiKey(
  imdbUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("users")
    .select("rpdb_api_key")
    .eq("imdb_user_id", imdbUserId)
    .single();

  if (error) {
    return null;
  }

  return data.rpdb_api_key;
}
