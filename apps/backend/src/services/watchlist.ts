import {
  DEFAULT_SORT_OPTION,
  DEFAULT_SORT_OPTIONS,
  isChartId,
  parseSortOption,
} from "@stremlist/shared";
import type { WatchlistData, SortOptions } from "@stremlist/shared";
import { supabase } from "../lib/supabase";
import { shuffleArray } from "../utils";
import {
  buildPosterUrl,
  classifyWatchlistError,
  fetchChart,
  fetchList,
  fetchWatchlist,
  isListId,
} from "./imdb-scraper";
import type { WatchlistErrorReason } from "./imdb-scraper";
import { getUserRpdbApiKey, getUserWatchlists } from "./user";
import {
  findCachedMeta,
  getCachedWatchlist,
  writeCachedWatchlist,
} from "./watchlist-cache";

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

async function upsertCache(
  watchlistId: string,
  watchlistData: WatchlistData,
  cachedAt: Date,
): Promise<string | null> {
  try {
    return await writeCachedWatchlist(watchlistId, watchlistData, cachedAt);
  } catch (error) {
    console.error(`Failed to cache watchlist ${watchlistId} in R2:`, error);
    return null;
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

interface FreshWatchlist {
  data: WatchlistData;
  cachedAt: Date;
  generation: string | null;
}

const inFlightRefreshes = new Map<string, Promise<FreshWatchlist>>();

function refreshKey(config: WatchlistFetchConfig): string {
  return `${config.watchlistId}:${config.imdbUserId}`;
}

async function fetchAndCacheWatchlist(
  config: WatchlistFetchConfig,
): Promise<FreshWatchlist> {
  const fetcher = isChartId(config.imdbUserId)
    ? fetchChart
    : isListId(config.imdbUserId)
      ? fetchList
      : fetchWatchlist;
  const data = await fetcher(config.imdbUserId, DEFAULT_SORT_OPTIONS, null);
  const cachedAt = new Date();
  const generation = await upsertCache(config.watchlistId, data, cachedAt);
  return { data, cachedAt, generation };
}

function refreshWatchlist(
  config: WatchlistFetchConfig,
): Promise<FreshWatchlist> {
  const key = refreshKey(config);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refresh = fetchAndCacheWatchlist(config);
  inFlightRefreshes.set(key, refresh);
  void refresh.then(
    () => {
      if (inFlightRefreshes.get(key) === refresh) {
        inFlightRefreshes.delete(key);
      }
    },
    () => {
      if (inFlightRefreshes.get(key) === refresh) {
        inFlightRefreshes.delete(key);
      }
    },
  );
  return refresh;
}

export async function getWatchlistByConfig(
  config: WatchlistFetchConfig,
): Promise<WatchlistData> {
  const sortOptionStr = config.sortOption ?? DEFAULT_SORT_OPTION;
  const sortOptions = parseSortOption(sortOptionStr);

  // Cache-first happy path: a fresh R2 hit avoids both Supabase writes and IMDb
  // calls. The catalog stays canonical (added_at-asc, raw posters), so sort +
  // RPDB are always applied at serve time.
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
      return resortCachedData(
        cached.data,
        sortOptions,
        cached.generation,
        config.rpdbApiKey,
      );
    }
  }

  try {
    // A config save can prewarm at the same moment Stremio requests a catalog.
    // Share the canonical scrape/cache write, then apply caller-specific
    // sorting and poster customization below.
    const {
      data: fresh,
      cachedAt,
      generation,
    } = await refreshWatchlist(config);

    if (!config.skipUserTimestamp) {
      await supabase
        .from("users")
        .update({ last_fetched_at: cachedAt.toISOString() })
        .eq("imdb_user_id", config.ownerUserId);
    }
    return resortCachedData(
      fresh,
      sortOptions,
      generation ?? contentGeneration(config.watchlistId, fresh),
      config.rpdbApiKey,
    );
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
        return resortCachedData(
          cached.data,
          sortOptions,
          cached.generation,
          config.rpdbApiKey,
        );
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
 * throws: on a cold cache, a miss, or any R2 error it returns null so the meta
 * route answers { meta: null } and Stremio falls back to Cinemeta. It also
 * deliberately ignores the cache TTL — opening one already-cached title must
 * not trigger a refresh. R2 manifests provide the membership check, so a miss
 * does not download and decompress each full catalog. The old per-request
 * getWatchlistByConfig fan-out synchronously re-scraped IMDb on stale caches
 * and caused the prod 500/504 storm on /:userId/meta/...
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

    const found = await findCachedMeta(
      watchlists.map((watchlist) => watchlist.id),
      type,
      id,
    );
    if (!found) return null;

    return {
      ...found,
      poster: buildPosterUrl(found.id, found.poster, rpdbApiKey),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`findMetaInUserCache failed for ${userId}:`, message);
    return null;
  }
}

function resortCachedData(
  data: WatchlistData,
  sortOptions: SortOptions,
  generation: string,
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
    return {
      metas: applyRpdbPostersToMetas(
        shuffleArray(metas, generation),
        rpdbApiKey,
      ),
    };
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

function contentGeneration(watchlistId: string, data: WatchlistData): string {
  return `${watchlistId}:${data.metas
    .map((meta) => `${meta.type}:${meta.id}`)
    .join(",")}`;
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
