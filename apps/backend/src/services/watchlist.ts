import {
  DEFAULT_SORT_OPTION,
  DEFAULT_SORT_OPTIONS,
  parseSortOption,
} from "@stremlist/shared";
import type { WatchlistData, SortOptions } from "@stremlist/shared";
import { supabase } from "../lib/supabase";
import { shuffleArray } from "../utils";
import {
  buildPosterUrl,
  fetchList,
  fetchWatchlist,
  isListId,
} from "./imdb-scraper";

const CACHE_TTL_MS =
  (Number.isFinite(Number(process.env.CACHE_TTL_MINUTES))
    ? Number(process.env.CACHE_TTL_MINUTES)
    : 30) * 60_000;

async function getCachedWatchlist(
  watchlistId: string,
): Promise<{ data: WatchlistData; cachedAt: Date } | null> {
  const { data, error } = await supabase
    .from("watchlist_cache")
    .select("cached_data, cached_at")
    .eq("watchlist_id", watchlistId)
    .single();

  if (error) {
    console.error(
      `Failed to get cached watchlist for ${watchlistId}:`,
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
  watchlistId: string,
  watchlistData: WatchlistData,
): Promise<void> {
  const { error } = await supabase.from("watchlist_cache").upsert(
    {
      watchlist_id: watchlistId,
      cached_data: watchlistData,
      cached_at: new Date().toISOString(),
    },
    { onConflict: "watchlist_id" },
  );

  if (error) {
    console.error(
      `Failed to cache watchlist for ${watchlistId}:`,
      error.message,
    );
  }
}

export interface WatchlistFetchConfig {
  ownerUserId: string;
  watchlistId: string;
  imdbUserId: string;
  sortOption: string | null | undefined;
  rpdbApiKey?: string | null;
  forceFresh?: boolean;
  skipUserTimestamp?: boolean;
}

export async function getWatchlistByConfig(
  config: WatchlistFetchConfig,
): Promise<WatchlistData> {
  const sortOptionStr = config.sortOption ?? DEFAULT_SORT_OPTION;
  const sortOptions = parseSortOption(sortOptionStr);

  // Cache-first happy path: a fresh cache hit is a single indexed SELECT with
  // zero writes and zero IMDb calls. The cached blob is stored canonically
  // (added_at-asc, raw posters), so sort + RPDB are always applied at serve time.
  if (!config.forceFresh) {
    const cached = await getCachedWatchlist(config.watchlistId);
    if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
      return resortCachedData(cached.data, sortOptions, config.rpdbApiKey);
    }
  }

  try {
    const fetcher = isListId(config.imdbUserId) ? fetchList : fetchWatchlist;
    // Fetch canonically so the cached blob is sort- and RPDB-key-agnostic.
    const fresh = await fetcher(config.imdbUserId, DEFAULT_SORT_OPTIONS, null);

    await Promise.all([
      upsertCache(config.watchlistId, fresh),
      // Tier 2: only stamp the analytics timestamp on a real refresh.
      ...(config.skipUserTimestamp
        ? []
        : [
            supabase
              .from("users")
              .update({ last_fetched_at: new Date().toISOString() })
              .eq("imdb_user_id", config.ownerUserId),
          ]),
    ]);
    return resortCachedData(fresh, sortOptions, config.rpdbApiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `IMDb fetch failed for watchlist ${config.watchlistId}, trying cache:`,
      message,
    );

    const cached = await getCachedWatchlist(config.watchlistId);
    if (cached) {
      console.log(
        `Serving cached watchlist for ${config.watchlistId} as fallback`,
      );
      await supabase
        .from("users")
        .update({ last_cache_served_at: new Date().toISOString() })
        .eq("imdb_user_id", config.ownerUserId);
      return resortCachedData(cached.data, sortOptions, config.rpdbApiKey);
    }

    throw new Error(
      `Failed to fetch watchlist ${config.watchlistId} and no cache available: ${message}`,
    );
  }
}

function resortCachedData(
  data: WatchlistData,
  sortOptions: SortOptions,
  rpdbApiKey?: string | null,
): WatchlistData {
  const metas = [...data.metas];
  const { by, order } = sortOptions;
  const multiplier = order === "desc" ? -1 : 1;

  if (by === "added_at") {
    if (order === "desc") {
      metas.reverse();
    }
    return { metas: applyRpdbPostersToMetas(metas, rpdbApiKey) };
  }

  if (by === "random") {
    return { metas: applyRpdbPostersToMetas(shuffleArray(metas), rpdbApiKey) };
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

  return { metas: applyRpdbPostersToMetas(metas, rpdbApiKey) };
}

function applyRpdbPostersToMetas(
  metas: WatchlistData["metas"],
  rpdbApiKey?: string | null,
): WatchlistData["metas"] {
  return metas.map((meta) => ({
    ...meta,
    poster: buildPosterUrl(meta.id, meta.poster, rpdbApiKey),
  }));
}
