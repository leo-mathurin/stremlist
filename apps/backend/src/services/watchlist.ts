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
  classifyWatchlistError,
  fetchList,
  fetchWatchlist,
  isListId,
} from "./imdb-scraper";
import type { WatchlistErrorReason } from "./imdb-scraper";
import { getUserRpdbApiKey, getUserWatchlists } from "./user";

export type WatchlistUnavailableReason = WatchlistErrorReason | "unavailable";

/**
 * Thrown when a watchlist can't be served at all: the IMDb fetch failed and
 * there is no cache to fall back on. `reason` lets callers distinguish an
 * expected user-state ("private" / "not_found" → degrade gracefully) from an
 * unknown/transient failure ("unavailable" → treat as a real server error).
 */
export class WatchlistUnavailableError extends Error {
  readonly reason: WatchlistUnavailableReason;

  constructor(reason: WatchlistUnavailableReason, message: string) {
    super(message);
    this.name = "WatchlistUnavailableError";
    this.reason = reason;
  }
}

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
  /**
   * When true, a failed IMDb fetch is NOT masked by serving the existing cache:
   * the error is rethrown so the caller can count it as a genuine failure. Used
   * by the manual-refresh path, which forces a fresh fetch and must report
   * honestly whether each list actually updated. The catalog path leaves this
   * false so it keeps degrading gracefully to the last-known cached items.
   */
  noCacheFallback?: boolean;
}

export async function getWatchlistByConfig(
  config: WatchlistFetchConfig,
): Promise<WatchlistData> {
  const sortOptionStr = config.sortOption ?? DEFAULT_SORT_OPTION;
  const sortOptions = parseSortOption(sortOptionStr);

  // Cache-first happy path: a fresh cache hit is a single indexed SELECT with
  // zero writes and zero IMDb calls. The cached blob is stored canonically
  // (added_at-asc, raw posters), so sort + RPDB are always applied at serve time.
  //
  // An *empty* cache (0 items) is treated as a non-hit so we always re-fetch:
  // it's indistinguishable from "the list went private since we cached it", and
  // a private list must surface its error (see catch below) rather than be
  // served as a silently-empty catalog. Genuinely-empty public lists just
  // re-fetch (cheap, and they're rare).
  if (!config.forceFresh) {
    const cached = await getCachedWatchlist(config.watchlistId);
    if (
      cached &&
      cached.data.metas.length > 0 &&
      Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS
    ) {
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

    // Serve a non-empty cache as a graceful fallback (keep showing the user's
    // last-known items). An empty cache is NOT a useful fallback — fall through
    // and surface the real reason (e.g. the private-list card) instead of a
    // silently-empty catalog. `noCacheFallback` callers (manual refresh) skip
    // this entirely so a failed fetch is reported as a failure, not masked as a
    // successful refresh of stale data.
    if (!config.noCacheFallback) {
      const cached = await getCachedWatchlist(config.watchlistId);
      if (cached && cached.data.metas.length > 0) {
        console.log(
          `Serving cached watchlist for ${config.watchlistId} as fallback`,
        );
        await supabase
          .from("users")
          .update({ last_cache_served_at: new Date().toISOString() })
          .eq("imdb_user_id", config.ownerUserId);
        return resortCachedData(cached.data, sortOptions, config.rpdbApiKey);
      }
    }

    throw new WatchlistUnavailableError(
      classifyWatchlistError(err) ?? "unavailable",
      `Failed to fetch watchlist ${config.watchlistId} and no cache available: ${message}`,
    );
  }
}

/**
 * Resolve a single meta item for a Stremio detail page using ONLY the cache.
 *
 * Unlike getWatchlistByConfig this never scrapes IMDb, never writes, and never
 * throws: on a cold cache, a miss, or any DB error it returns null so the meta
 * route answers { meta: null } and Stremio falls back to Cinemeta. It also
 * deliberately ignores the cache TTL — opening one already-cached title must
 * not trigger a refresh. The old per-request fan-out (getWatchlistByConfig for
 * every list, which synchronously re-scraped IMDb on stale caches) is what
 * caused the prod 500/504 storm on /:userId/meta/...
 */
export async function findMetaInUserCache(
  userId: string,
  type: string,
  id: string,
): Promise<WatchlistData["metas"][number] | null> {
  try {
    const [watchlists, rpdbApiKey] = await Promise.all([
      getUserWatchlists(userId),
      getUserRpdbApiKey(userId),
    ]);
    if (watchlists.length === 0) return null;

    const { data, error } = await supabase
      .from("watchlist_cache")
      .select("cached_data")
      .in(
        "watchlist_id",
        watchlists.map((w) => w.id),
      );

    if (error) {
      console.error(`Failed to read meta cache for ${userId}:`, error.message);
      return null;
    }

    for (const row of data) {
      const found = (row.cached_data as WatchlistData).metas.find(
        (m) => m.id === id && m.type === type,
      );
      if (found) {
        return {
          ...found,
          poster: buildPosterUrl(found.id, found.poster, rpdbApiKey),
        };
      }
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`findMetaInUserCache failed for ${userId}:`, message);
    return null;
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
