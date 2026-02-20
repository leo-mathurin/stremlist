import { DEFAULT_SORT_OPTION, parseSortOption } from "@stremlist/shared";
import type { WatchlistData, SortOptions } from "@stremlist/shared";
import { supabase } from "../lib/supabase";
import { shuffleArray } from "../utils";
import { buildPosterUrl, fetchWatchlist } from "./imdb-scraper";
import { ensureUser, getUserRpdbApiKey, getUserWatchlists } from "./user";

const WATCHLIST_DEBUG_PREFIX = "[watchlist-service]";

interface UserWatchlistConfig {
  id: string;
  imdbUserId: string;
  sortOption: string;
}

async function getCachedWatchlist(
  watchlistId: string,
): Promise<{ data: WatchlistData; cachedAt: Date } | null> {
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} cache lookup start`,
    JSON.stringify({ watchlistId }),
  );

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

  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} cache hit`,
    JSON.stringify({
      watchlistId,
      cachedAt: data.cached_at,
      cachedMetasCount: data.cached_data.metas.length,
    }),
  );

  return {
    data: data.cached_data,
    cachedAt: new Date(data.cached_at),
  };
}

async function upsertCache(
  watchlistId: string,
  watchlistData: WatchlistData,
): Promise<void> {
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} cache upsert start`,
    JSON.stringify({
      watchlistId,
      metasCount: watchlistData.metas.length,
    }),
  );

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
    return;
  }

  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} cache upsert success`,
    JSON.stringify({
      watchlistId,
      metasCount: watchlistData.metas.length,
    }),
  );
}

export interface WatchlistFetchConfig {
  ownerUserId: string;
  watchlistId: string;
  imdbUserId: string;
  sortOption: string | null | undefined;
  rpdbApiKey?: string | null;
}

export async function getWatchlistByConfig(
  config: WatchlistFetchConfig,
): Promise<WatchlistData> {
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} getWatchlistByConfig start`,
    JSON.stringify({
      ownerUserId: config.ownerUserId,
      watchlistId: config.watchlistId,
      imdbUserId: config.imdbUserId,
      sortOption: config.sortOption ?? DEFAULT_SORT_OPTION,
      hasRpdbApiKey: Boolean(config.rpdbApiKey),
    }),
  );

  await ensureUser(config.ownerUserId);

  const sortOptionStr = config.sortOption ?? DEFAULT_SORT_OPTION;
  const sortOptions = parseSortOption(sortOptionStr);
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} parsed sort option`,
    JSON.stringify({
      watchlistId: config.watchlistId,
      rawSortOption: sortOptionStr,
      parsedSortBy: sortOptions.by,
      parsedSortOrder: sortOptions.order,
    }),
  );

  try {
    console.log(
      `${WATCHLIST_DEBUG_PREFIX} fetching IMDb watchlist`,
      JSON.stringify({
        watchlistId: config.watchlistId,
        imdbUserId: config.imdbUserId,
      }),
    );
    const fresh = await fetchWatchlist(
      config.imdbUserId,
      sortOptions,
      config.rpdbApiKey,
    );
    console.debug(
      `${WATCHLIST_DEBUG_PREFIX} IMDb fetch success`,
      JSON.stringify({
        watchlistId: config.watchlistId,
        fetchedMetasCount: fresh.metas.length,
      }),
    );

    await Promise.all([
      upsertCache(config.watchlistId, fresh),
      supabase
        .from("users")
        .update({ last_fetched_at: new Date().toISOString() })
        .eq("imdb_user_id", config.ownerUserId),
    ]);
    console.debug(
      `${WATCHLIST_DEBUG_PREFIX} user fetch timestamp updated`,
      JSON.stringify({
        ownerUserId: config.ownerUserId,
        watchlistId: config.watchlistId,
      }),
    );
    return fresh;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${WATCHLIST_DEBUG_PREFIX} IMDb fetch failed, trying cache`,
      JSON.stringify({
        ownerUserId: config.ownerUserId,
        watchlistId: config.watchlistId,
        imdbUserId: config.imdbUserId,
        error: message,
      }),
    );

    console.debug(
      `${WATCHLIST_DEBUG_PREFIX} attempting cache fallback`,
      JSON.stringify({ watchlistId: config.watchlistId }),
    );

    const cached = await getCachedWatchlist(config.watchlistId);
    if (cached) {
      console.log(
        `${WATCHLIST_DEBUG_PREFIX} serving cached watchlist fallback`,
        JSON.stringify({
          watchlistId: config.watchlistId,
          ownerUserId: config.ownerUserId,
          cachedMetasCount: cached.data.metas.length,
          cachedAt: cached.cachedAt.toISOString(),
        }),
      );

      await supabase
        .from("users")
        .update({ last_cache_served_at: new Date().toISOString() })
        .eq("imdb_user_id", config.ownerUserId);
      console.debug(
        `${WATCHLIST_DEBUG_PREFIX} user cache-served timestamp updated`,
        JSON.stringify({
          ownerUserId: config.ownerUserId,
          watchlistId: config.watchlistId,
        }),
      );

      const resorted = resortCachedData(
        cached.data,
        sortOptions,
        config.rpdbApiKey,
      );
      console.debug(
        `${WATCHLIST_DEBUG_PREFIX} cached data resorted`,
        JSON.stringify({
          watchlistId: config.watchlistId,
          metasCount: resorted.metas.length,
          sortBy: sortOptions.by,
          sortOrder: sortOptions.order,
        }),
      );
      return resorted;
    }

    console.error(
      `${WATCHLIST_DEBUG_PREFIX} cache fallback unavailable`,
      JSON.stringify({
        ownerUserId: config.ownerUserId,
        watchlistId: config.watchlistId,
        error: message,
      }),
    );

    throw new Error(
      `Failed to fetch watchlist ${config.watchlistId} and no cache available: ${message}`,
    );
  }
}

export async function getWatchlist(
  userId: string,
  sortOptionOverride?: string | null,
): Promise<WatchlistData> {
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} getWatchlist (legacy single-watchlist path)`,
    JSON.stringify({ userId, sortOptionOverride: sortOptionOverride ?? null }),
  );

  await ensureUser(userId);
  const watchlists = (await getUserWatchlists(userId)) as UserWatchlistConfig[];
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} watchlists loaded for user`,
    JSON.stringify({
      userId,
      watchlistsCount: watchlists.length,
      firstWatchlistId: watchlists.at(0)?.id ?? null,
    }),
  );

  const firstWatchlist = watchlists.at(0);

  if (!firstWatchlist) {
    throw new Error(`No watchlists configured for ${userId}`);
  }

  const rpdbApiKey = await getUserRpdbApiKey(userId);
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} RPDB key loaded for legacy path`,
    JSON.stringify({ userId, hasRpdbApiKey: Boolean(rpdbApiKey) }),
  );

  return getWatchlistByConfig({
    ownerUserId: userId,
    watchlistId: firstWatchlist.id,
    imdbUserId: firstWatchlist.imdbUserId,
    sortOption: sortOptionOverride ?? firstWatchlist.sortOption,
    rpdbApiKey,
  });
}

function resortCachedData(
  data: WatchlistData,
  sortOptions: SortOptions,
  rpdbApiKey?: string | null,
): WatchlistData {
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} resortCachedData start`,
    JSON.stringify({
      metasCount: data.metas.length,
      sortBy: sortOptions.by,
      sortOrder: sortOptions.order,
      hasRpdbApiKey: Boolean(rpdbApiKey),
    }),
  );

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
  console.debug(
    `${WATCHLIST_DEBUG_PREFIX} applying RPDB posters`,
    JSON.stringify({
      metasCount: metas.length,
      hasRpdbApiKey: Boolean(rpdbApiKey),
    }),
  );

  return metas.map((meta) => ({
    ...meta,
    poster: buildPosterUrl(meta.id, meta.poster, rpdbApiKey),
  }));
}
