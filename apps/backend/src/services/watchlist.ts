import { parseSortOption } from "@stremlist/shared";
import type { WatchlistData, SortOptions } from "@stremlist/shared";
import { supabase } from "../lib/supabase";
import { shuffleArray } from "../utils";
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

  const sortOptionStr = sortOptionOverride ?? (await getUserSortOption(userId));
  const sortOptions = parseSortOption(sortOptionStr);

  try {
    console.log(`Fetching watchlist from IMDb for ${userId}...`);
    const fresh = await fetchWatchlist(userId, sortOptions);
    await Promise.all([
      upsertCache(userId, fresh),
      supabase
        .from("users")
        .update({ last_fetched_at: new Date().toISOString() })
        .eq("imdb_user_id", userId),
    ]);
    return fresh;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`IMDb fetch failed for ${userId}, trying cache:`, message);

    const cached = await getCachedWatchlist(userId);
    if (cached) {
      console.log(`Serving cached watchlist for ${userId} as fallback`);
      await supabase
        .from("users")
        .update({ last_cache_served_at: new Date().toISOString() })
        .eq("imdb_user_id", userId);
      return resortCachedData(cached.data, sortOptions);
    }

    throw new Error(
      `Failed to fetch watchlist and no cache available: ${message}`,
    );
  }
}

function resortCachedData(
  data: WatchlistData,
  sortOptions: SortOptions,
): WatchlistData {
  const metas = [...data.metas];
  const { by, order } = sortOptions;
  const multiplier = order === "desc" ? -1 : 1;

  if (by === "added_at") {
    if (order === "desc") {
      metas.reverse();
    }
    return { metas };
  }

  if (by === "random") {
    return { metas: shuffleArray(metas) };
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
