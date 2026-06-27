import {
  DEFAULT_SORT_OPTION,
  DEFAULT_SORT_OPTIONS,
  isChartId,
  parseSortOption,
} from "@stremlist/shared";
import type {
  WatchlistData,
  SortOptions,
  TablesInsert,
} from "@stremlist/shared";
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

// PostgREST caps a single SELECT at 1000 rows, so a watchlist with more items
// (the prod max is ~9951) would be silently truncated. Page through in
// 1000-row windows ordered by `position` and stitch the full list back together.
const CACHE_PAGE_SIZE = 1000;

// Upsert in smaller batches to keep each request body modest (a 9951-item list
// is several MB) and to bound the size of each ON CONFLICT command.
const CACHE_WRITE_CHUNK_SIZE = 500;

async function getCachedWatchlist(
  watchlistId: string,
): Promise<{ data: WatchlistData; cachedAt: Date } | null> {
  // Read the normalised per-item cache and reconstruct the WatchlistData blob.
  // `position` preserves the canonical (added_at-asc) order the items were
  // stored in, so resortCachedData applies sort + RPDB at serve time as before.
  const metas: WatchlistData["metas"] = [];
  let cachedAt: string | null = null;

  for (let from = 0; ; from += CACHE_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("watchlist_cache_items")
      .select("data, cached_at")
      .eq("watchlist_id", watchlistId)
      .order("position", { ascending: true })
      .range(from, from + CACHE_PAGE_SIZE - 1);

    if (error) {
      console.error(
        `Failed to get cached watchlist for ${watchlistId}:`,
        error.message,
      );
      return null;
    }

    if (cachedAt === null && data.length > 0) cachedAt = data[0].cached_at;
    for (const row of data) metas.push(row.data);

    if (data.length < CACHE_PAGE_SIZE) break;
  }

  // Zero rows == miss, same contract as the old single-blob lookup. This keeps
  // the "empty cache is a non-hit, always re-fetch" logic in the caller intact.
  if (metas.length === 0 || cachedAt === null) return null;

  return {
    data: { metas },
    cachedAt: new Date(cachedAt),
  };
}

async function upsertCache(
  watchlistId: string,
  watchlistData: WatchlistData,
): Promise<void> {
  // One shared timestamp for the whole generation. We upsert the new rows then
  // prune anything older — never delete-then-insert, which would open a window
  // where a concurrent catalog/refresh read sees zero rows (a false miss) and
  // re-scrapes IMDb.
  const cachedAt = new Date().toISOString();

  // Empty list: clear the set so the next read is a miss (matches the old
  // behaviour where an empty blob was treated as a non-hit). No upsert needed.
  if (watchlistData.metas.length === 0) {
    const { error } = await supabase
      .from("watchlist_cache_items")
      .delete()
      .eq("watchlist_id", watchlistId);
    if (error) {
      console.error(
        `Failed to clear watchlist cache for ${watchlistId}:`,
        error.message,
      );
    }
    return;
  }

  // De-duplicate by item_id, keeping the first occurrence. IMDb lists are NOT
  // guaranteed to be sets — some carry the same `tt` id twice. Without this the
  // upsert hits "ON CONFLICT DO UPDATE command cannot affect row a second time"
  // (Postgres refuses to touch the same PK row twice in one command) and the
  // whole cache write fails. Keeping the first occurrence mirrors the backfill's
  // ON CONFLICT DO NOTHING. `position` stays the original index so order holds.
  const seen = new Set<string>();
  const rows: TablesInsert<"watchlist_cache_items">[] = [];
  watchlistData.metas.forEach((meta, i) => {
    if (seen.has(meta.id)) return;
    seen.add(meta.id);
    rows.push({
      watchlist_id: watchlistId,
      item_id: meta.id,
      type: meta.type,
      position: i,
      data: meta,
      cached_at: cachedAt,
    });
  });

  // Chunk the write: a single upsert of a 9951-item list is a multi-MB request
  // body. Bail before the prune if any chunk fails so we never wipe the
  // previous generation on a partial write.
  for (let i = 0; i < rows.length; i += CACHE_WRITE_CHUNK_SIZE) {
    const { error: upsertError } = await supabase
      .from("watchlist_cache_items")
      .upsert(rows.slice(i, i + CACHE_WRITE_CHUNK_SIZE), {
        onConflict: "watchlist_id,item_id",
      });

    if (upsertError) {
      console.error(
        `Failed to cache watchlist for ${watchlistId}:`,
        upsertError.message,
      );
      return;
    }
  }

  // Prune the previous generation: any row not touched by this upsert still
  // carries an older cached_at. Items dropped from the list disappear; items
  // that remain were just refreshed to `cachedAt` so they survive.
  const { error: pruneError } = await supabase
    .from("watchlist_cache_items")
    .delete()
    .eq("watchlist_id", watchlistId)
    .lt("cached_at", cachedAt);

  if (pruneError) {
    console.error(
      `Failed to prune stale cache for ${watchlistId}:`,
      pruneError.message,
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
    const fetcher = isChartId(config.imdbUserId)
      ? fetchChart
      : isListId(config.imdbUserId)
        ? fetchList
        : fetchWatchlist;
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

    // Single indexed row lookup instead of pulling every list's full blob.
    // Still scoped to the user's own watchlists: Stremlist meta only overrides
    // Cinemeta for titles that are actually in one of the user's lists.
    const { data, error } = await supabase
      .from("watchlist_cache_items")
      .select("data")
      .eq("item_id", id)
      .eq("type", type)
      .in(
        "watchlist_id",
        watchlists.map((w) => w.id),
      )
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`Failed to read meta cache for ${userId}:`, error.message);
      return null;
    }

    if (!data) return null;

    const found = data.data;
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
