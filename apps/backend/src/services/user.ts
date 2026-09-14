import { DEFAULT_SORT_OPTION } from "@stremlist/shared";
import type {
  CatalogSettings,
  ConfigWatchlist,
  Tables,
} from "@stremlist/shared";
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
): Promise<ConfigWatchlist[]> {
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

  const keepIds = new Set(watchlists.map((w) => w.id));
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

    const cleanupResults = await Promise.allSettled(
      toDelete.map((watchlistId) => deleteCachedWatchlist(watchlistId)),
    );
    cleanupResults.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `Failed to delete R2 cache for removed watchlist ${toDelete[index]}:`,
          result.reason,
        );
      }
    });
  }

  // PostgREST uses one column set per batch. Keep omitted settings out of that
  // set entirely so a concurrent save cannot be overwritten by a stale snapshot.
  await Promise.all(
    [
      watchlists.filter((w) => w.catalogSettings === undefined),
      watchlists.filter((w) => w.catalogSettings !== undefined),
    ].map(async (batch) => {
      if (batch.length === 0) return;
      const rows = batch.map((w) => ({
        ...(w.id ? { id: w.id } : {}),
        owner_user_id: ownerUserId,
        imdb_user_id: w.imdbUserId,
        catalog_title: w.catalogTitle ?? "",
        sort_option: w.sortOption,
        display_mode: w.displayMode ?? "split",
        position: w.position,
        ...(w.catalogSettings === undefined
          ? {}
          : { catalog_settings: { ...w.catalogSettings } }),
        updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from("user_watchlists")
        .upsert(rows, { onConflict: "id", defaultToNull: false });
      if (error) throw error;
    }),
  );

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
