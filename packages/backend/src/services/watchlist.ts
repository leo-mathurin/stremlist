import {
  CACHE_TTL_MS,
  parseSortOption
  
  
} from "@stremlist/shared";
import type {WatchlistData, SortOptions} from "@stremlist/shared";
import { supabase } from "../lib/supabase";
import { fetchWatchlist } from "./imdb-scraper";
import { ensureUser, getUserSortOption } from "./user";

async function getCachedWatchlist(
  userId: string,
): Promise<{ data: WatchlistData; cachedAt: Date } | null> {
  const { data, error } = await supabase
    .from("watchlist_cache")
    .select("cached_data, cached_at")
    .eq("imdb_user_id", userId)
    .single();

  if (error) {
    console.error(
      `Failed to get cached watchlist for ${userId}:`,
      error.message,
    );
    return null;
  }

  return {
    data: data.cached_data,
    cachedAt: new Date(data.cached_at),
  };
}

export async function invalidateWatchlistCache(userId: string): Promise<void> {
  const { error } = await supabase
    .from("watchlist_cache")
    .delete()
    .eq("imdb_user_id", userId);

  if (error) {
    console.error(`Failed to invalidate cache for ${userId}:`, error.message);
  }
}

async function upsertCache(
  userId: string,
  watchlistData: WatchlistData,
): Promise<void> {
  const { error } = await supabase.from("watchlist_cache").upsert(
    {
      imdb_user_id: userId,
      cached_data: watchlistData,
      cached_at: new Date().toISOString(),
    },
    { onConflict: "imdb_user_id" },
  );

  if (error) {
    console.error(`Failed to cache watchlist for ${userId}:`, error.message);
  }
}

export async function getWatchlist(
  userId: string,
  sortOptionOverride?: string | null,
): Promise<WatchlistData> {
  await ensureUser(userId);

  const sortOptionStr =
    sortOptionOverride ?? (await getUserSortOption(userId));
  const sortOptions = parseSortOption(sortOptionStr);

  const cached = await getCachedWatchlist(userId);

  if (cached) {
    const age = Date.now() - cached.cachedAt.getTime();

    if (age < CACHE_TTL_MS) {
      console.log(
        `Cache hit for ${userId} (age: ${Math.round(age / 60000)}m)`,
      );
      return resortCachedData(cached.data, sortOptions);
    }

    console.log(
      `Cache stale for ${userId} (age: ${Math.round(age / 60000)}m), refreshing...`,
    );
    try {
      const fresh = await fetchWatchlist(userId, sortOptions);
      await upsertCache(userId, fresh);
      return fresh;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `Refresh failed for ${userId}, serving stale cache:`,
        message,
      );
      return resortCachedData(cached.data, sortOptions);
    }
  }

  console.log(`No cache for ${userId}, fetching from IMDb...`);
  const fresh = await fetchWatchlist(userId, sortOptions);
  await upsertCache(userId, fresh);
  return fresh;
}

function resortCachedData(
  data: WatchlistData,
  sortOptions: SortOptions,
): WatchlistData {
  const metas = [...data.metas];
  const { by, order } = sortOptions;
  const multiplier = order === "desc" ? -1 : 1;

  if (by === "added_at") {
    if (order === "desc") {metas.reverse();}
    return { metas };
  }

  metas.sort((a, b) => {
    switch (by) {
      case "year": {
        const ya = a.releaseInfo ? parseInt(a.releaseInfo, 10) || 0 : 0;
        const yb = b.releaseInfo ? parseInt(b.releaseInfo, 10) || 0 : 0;
        return (ya - yb) * multiplier;
      }
      case "rating": {
        const ra = a.imdbRating ? parseFloat(a.imdbRating) || 0 : 0;
        const rb = b.imdbRating ? parseFloat(b.imdbRating) || 0 : 0;
        return (ra - rb) * multiplier;
      }
      case "title":
      default:
        return a.name.localeCompare(b.name) * multiplier;
    }
  });

  return { metas };
}
