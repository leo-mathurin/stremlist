import { DEFAULT_SORT_OPTION } from "@stremlist/shared";
import type { Tables } from "@stremlist/shared";
import { supabase } from "../lib/supabase";

type User = Tables<"users">;
type UserWatchlist = Tables<"user_watchlists">;

interface ConfigWatchlistRow {
  id: string;
  imdbUserId: string;
  catalogTitle: string;
  sortOption: string;
  position: number;
}

interface UserConfigUpdateWatchlistRow {
  id?: string;
  imdbUserId: string;
  catalogTitle?: string;
  sortOption: string;
  position: number;
}

const DEFAULT_WATCHLIST_TITLE = "";

function mapWatchlistRow(row: UserWatchlist): ConfigWatchlistRow {
  return {
    id: row.id,
    imdbUserId: row.imdb_user_id,
    catalogTitle: row.catalog_title,
    sortOption: row.sort_option,
    position: row.position,
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
): Promise<ConfigWatchlistRow[]> {
  await seedDefaultWatchlist(ownerUserId);
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
): Promise<ConfigWatchlistRow | null> {
  await seedDefaultWatchlist(ownerUserId);
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
): Promise<ConfigWatchlistRow[]> {
  const { data: existingRows, error: existingError } = await supabase
    .from("user_watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId);

  if (existingError) {
    console.error(
      `Failed to fetch existing watchlists for ${ownerUserId}:`,
      existingError.message,
    );
    throw existingError;
  }

  const normalized = watchlists.map((watchlist) => ({
    id: watchlist.id ?? crypto.randomUUID(),
    owner_user_id: ownerUserId,
    imdb_user_id: watchlist.imdbUserId,
    catalog_title: watchlist.catalogTitle ?? "",
    sort_option: watchlist.sortOption,
    position: watchlist.position,
    updated_at: new Date().toISOString(),
  }));

  const keepIds = new Set(normalized.map((item) => item.id));
  const existingIds = existingRows.map((row) => row.id);
  const toDelete = existingIds.filter((id) => !keepIds.has(id));

  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("user_watchlists")
      .delete()
      .eq("owner_user_id", ownerUserId)
      .in("id", toDelete);

    if (deleteError) {
      console.error(
        `Failed to delete removed watchlists for ${ownerUserId}:`,
        deleteError.message,
      );
      throw deleteError;
    }
  }

  if (normalized.length > 0) {
    const { error: upsertError } = await supabase
      .from("user_watchlists")
      .upsert(normalized, { onConflict: "id" });

    if (upsertError) {
      console.error(
        `Failed to upsert watchlists for ${ownerUserId}:`,
        upsertError.message,
      );
      throw upsertError;
    }
  }

  return getUserWatchlists(ownerUserId);
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

export async function setUserRpdbApiKey(
  imdbUserId: string,
  rpdbApiKey: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ rpdb_api_key: rpdbApiKey })
    .eq("imdb_user_id", imdbUserId);

  if (error) {
    console.error(
      `Failed to update RPDB API key for ${imdbUserId}:`,
      error.message,
    );
    throw error;
  }
}
