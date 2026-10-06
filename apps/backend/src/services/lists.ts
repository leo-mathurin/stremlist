import type { ProviderId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type {
  StremioMeta,
  WatchlistData,
} from "@stremlist/shared/stremio.types";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type {
  ProviderAdapter,
  ProviderContext,
  SourceUnavailableReason,
} from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
import { enrichTitles } from "../titles/enrich";
import { DEFAULT_RESOLVE_BUDGET_MS, resolveEntries } from "../titles/resolver";
import type { AccountAccess } from "./accounts";
import { getAccountLists, markAccountFetched } from "./accounts";
import { ConnectionExpiredError, getConnectionAccess } from "./connections";
import { buildPosterUrl } from "./imdb-scraper";
import { findCachedMeta, getCachedList, writeCachedList } from "./list-cache";
import type { WatchlistSort } from "./watchlist-sort";
import { sortWatchlist } from "./watchlist-sort";

/**
 * When the ID resolver left entries untried, the next read comes this soon
 * instead of after the Provider's usual freshness.
 */
const RESUME_RESOLUTION_MS = 2 * 60_000;

/** Re-enrich every Title at least this often, so ratings stay current. */
const METADATA_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Thrown when a List cannot be served at all: the Provider read failed and no
 * cached Catalog is available. Every reason except "unavailable" is an
 * expected state shown as an information card.
 */
export class ListUnavailableError extends Error {
  readonly reason: SourceUnavailableReason;
  readonly provider: ProviderId;

  constructor(
    provider: ProviderId,
    reason: SourceUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "ListUnavailableError";
    this.reason = reason;
    this.provider = provider;
  }
}

export interface ListFetchConfig {
  accountId: string;
  listId: string;
  provider: ProviderId;
  sourceRef: string;
  sort: WatchlistSort;
  rpdbApiKey?: string | null;
  /**
   * Whether this request may read through the Account's Connection. False for
   * requests that come through a Legacy alias (ADR 0001).
   */
  allowConnection: boolean;
  forceFresh?: boolean;
  skipAccountTimestamp?: boolean;
  /**
   * Time the ID resolver may spend on entries without an IMDb ID. Catalog
   * requests keep the default; background prewarms can afford more.
   */
  resolveBudgetMs?: number;
  /**
   * When true, a failed read is not masked by the existing cache: the error is
   * rethrown so the manual refresh can report it honestly.
   */
  noCacheFallback?: boolean;
}

interface FreshList {
  data: WatchlistData;
  cachedAt: Date;
  generation: string | null;
}

const inFlightRefreshes = new Map<string, Promise<FreshList>>();

async function providerContext(
  config: ListFetchConfig,
): Promise<ProviderContext> {
  if (!config.allowConnection) {
    if (sourceRequiresConnection(config.provider, config.sourceRef)) {
      throw new SourceUnavailableError(
        "needs_connection",
        `${config.provider} ${config.sourceRef} needs a Connection`,
      );
    }
    return { connection: null };
  }
  const connection = await getConnectionAccess(
    config.accountId,
    config.provider,
  );
  if (
    !connection &&
    sourceRequiresConnection(config.provider, config.sourceRef)
  ) {
    throw new SourceUnavailableError(
      "needs_connection",
      `${config.provider} ${config.sourceRef} needs a Connection`,
    );
  }
  return { connection };
}

/** Turn a Provider snapshot into a canonical Catalog (provider order). */
async function buildCatalog(
  adapter: ProviderAdapter,
  config: ListFetchConfig,
  ctx: ProviderContext,
): Promise<{ data: WatchlistData; deferred: number }> {
  const snapshot = await adapter.fetchSource(config.sourceRef, ctx);
  if (snapshot.entries.every((entry) => entry.meta)) {
    return {
      data: {
        metas: snapshot.entries.flatMap((entry) =>
          entry.meta ? [entry.meta] : [],
        ),
      },
      deferred: 0,
    };
  }

  const { resolved, unresolved, deferred } = await resolveEntries(
    adapter,
    snapshot.entries,
    { budgetMs: config.resolveBudgetMs ?? DEFAULT_RESOLVE_BUDGET_MS },
  );

  const previous = new Map<string, StremioMeta>();
  const cached = await getCachedList(config.listId);
  if (cached && Date.now() - cached.cachedAt.getTime() < METADATA_MAX_AGE_MS) {
    for (const meta of cached.data.metas) previous.set(meta.id, meta);
  }

  const enriched = await enrichTitles(
    resolved
      .filter(({ entry }) => !entry.meta)
      .map(({ imdbId, entry }) => ({ imdbId, type: entry.type })),
    previous,
  );

  const seen = new Set<string>();
  const metas: StremioMeta[] = [];
  let unknown = 0;
  for (const { imdbId, entry } of resolved) {
    const meta = entry.meta ?? enriched.get(imdbId);
    if (!meta) {
      unknown += 1;
      continue;
    }
    const key = `${meta.type}:${meta.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    metas.push(meta);
  }

  if (unresolved > 0 || unknown > 0) {
    console.log(
      `List ${config.listId} (${config.provider}): ${metas.length} titles, ${unresolved} unresolved entries (${deferred} not tried yet), ${unknown} without metadata`,
    );
  }
  return { data: { metas }, deferred };
}

function freshnessOf(adapter: ProviderAdapter, sourceRef: string): number {
  return adapter.freshnessFor?.(sourceRef) ?? adapter.freshnessMs;
}

async function fetchAndCacheList(config: ListFetchConfig): Promise<FreshList> {
  if (!isProviderEnabled(config.provider)) {
    throw new SourceUnavailableError(
      "disabled",
      `${config.provider} is turned off`,
    );
  }
  const adapter = getProvider(config.provider);
  const ctx = await providerContext(config);
  const { data, deferred } = await buildCatalog(adapter, config, ctx);
  const cachedAt = new Date();
  // Back-date the cache so the next request resumes resolution soon.
  const storedAt =
    deferred > 0
      ? new Date(
          cachedAt.getTime() -
            Math.max(
              freshnessOf(adapter, config.sourceRef) - RESUME_RESOLUTION_MS,
              0,
            ),
        )
      : cachedAt;
  let generation: string | null = null;
  try {
    generation = await writeCachedList(config.listId, data, storedAt);
  } catch (error) {
    console.error(`Failed to cache list ${config.listId} in R2:`, error);
  }
  return { data, cachedAt, generation };
}

function refreshList(config: ListFetchConfig): Promise<FreshList> {
  // One read per List and per access level at a time: a save can prewarm at
  // the same moment Stremio requests the Catalog.
  const key = `${config.listId}:${config.allowConnection ? "c" : "p"}`;
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refresh = fetchAndCacheList(config);
  inFlightRefreshes.set(key, refresh);
  const clear = () => {
    if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key);
  };
  void refresh.then(clear, clear);
  return refresh;
}

function contentGeneration(listId: string, data: WatchlistData): string {
  return `${listId}:${data.metas.map((meta) => `${meta.type}:${meta.id}`).join(",")}`;
}

function present(
  data: WatchlistData,
  sort: WatchlistSort,
  generation: string,
  rpdbApiKey?: string | null,
): WatchlistData {
  return {
    metas: sortWatchlist(data.metas, sort, generation).map((meta) => ({
      ...meta,
      poster: buildPosterUrl(meta.id, meta.poster, rpdbApiKey),
    })),
  };
}

function toListError(
  provider: ProviderId,
  error: unknown,
  message: string,
): ListUnavailableError {
  // An expired Connection is an expected state (the user revoked access):
  // the catalog asks to connect again instead of a 500 that Stremio retries.
  const reason =
    error instanceof SourceUnavailableError
      ? error.reason
      : error instanceof ConnectionExpiredError
        ? "needs_connection"
        : "unavailable";
  return new ListUnavailableError(provider, reason, message);
}

/**
 * The Titles of a List, sorted and with posters applied. Cache first; a stale
 * or empty cache triggers a Provider read; a failed read falls back to the
 * last non-empty cached Catalog.
 */
export async function getListCatalog(
  config: ListFetchConfig,
): Promise<WatchlistData> {
  const adapter = getProvider(config.provider);
  const freshnessMs = freshnessOf(adapter, config.sourceRef);
  if (!config.forceFresh) {
    const cached = await getCachedList(config.listId);
    // An empty cache is not a hit: it cannot be told apart from "the list
    // became private", which must surface its reason.
    if (
      cached &&
      cached.data.metas.length > 0 &&
      Date.now() - cached.cachedAt.getTime() < freshnessMs
    ) {
      return present(
        cached.data,
        config.sort,
        cached.generation,
        config.rpdbApiKey,
      );
    }
  }

  try {
    const fresh = await refreshList(config);
    if (!config.skipAccountTimestamp) {
      await markAccountFetched(
        config.accountId,
        "last_fetched_at",
        fresh.cachedAt,
      );
    }
    return present(
      fresh.data,
      config.sort,
      fresh.generation ?? contentGeneration(config.listId, fresh.data),
      config.rpdbApiKey,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Reading list ${config.listId} (${config.provider}) failed, trying cache:`,
      message,
    );

    if (!config.noCacheFallback) {
      const cached = await getCachedList(config.listId);
      if (cached && cached.data.metas.length > 0) {
        await markAccountFetched(config.accountId, "last_cache_served_at");
        return present(
          cached.data,
          config.sort,
          cached.generation,
          config.rpdbApiKey,
        );
      }
    }

    throw toListError(
      config.provider,
      error,
      `Failed to read list ${config.listId} and no cache available: ${message}`,
    );
  }
}

/**
 * One Title's metadata for a Stremio detail page, from the cache only: never
 * a Provider read, never a write, never a throw. A miss answers null so
 * Stremio falls back to Cinemeta. (The old per-request fan-out that re-read
 * stale lists caused the production 500/504 storm on /meta.)
 */
export async function findMetaInAccountCache(
  { account, via }: AccountAccess,
  type: string,
  id: string,
): Promise<StremioMeta | null> {
  try {
    // A Legacy alias can be guessed: it must not reveal what Connection
    // lists (history, collection…) contain.
    const lists = (await getAccountLists(account.id)).filter(
      (list) =>
        via === "private" ||
        !sourceRequiresConnection(list.provider, list.sourceRef),
    );
    if (lists.length === 0) return null;
    const found = await findCachedMeta(
      lists.map((list) => list.id),
      type,
      id,
    );
    if (!found) return null;
    return {
      ...found,
      poster: buildPosterUrl(found.id, found.poster, account.rpdbApiKey),
    };
  } catch (error) {
    console.error(
      `findMetaInAccountCache failed for ${account.id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
