import { parseSortOption } from "@stremlist/shared/constants";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { StremioMeta, CatalogData } from "@stremlist/shared/stremio.types";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type {
  ConnectionAccess,
  ProviderAdapter,
  ProviderContext,
  SourceEntry,
} from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
import { enrichTitles } from "../titles/enrich";
import { DEFAULT_RESOLVE_BUDGET_MS, resolveEntries } from "../titles/resolver";
import type { AccountAccess } from "./accounts";
import { getAccountLists, markAccountFetched } from "./accounts";
import type { CatalogSort } from "./catalog-sort";
import { sortCatalog } from "./catalog-sort";
import { ConnectionExpiredError, getConnectionAccess } from "./connections";
import { buildPosterUrl } from "./imdb-scraper";
import {
  deleteCachedList,
  findCachedMeta,
  getCachedList,
  writeCachedList,
} from "./list-cache";
import type { RefreshOutcome } from "./sync-status";
import { forgetSyncStatuses, recordRefreshOutcome } from "./sync-status";

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
  readonly reason: SourceProblemReason;
  readonly provider: ProviderId;
  readonly sourceRef: string;

  constructor(
    source: { provider: ProviderId; sourceRef: string },
    reason: SourceProblemReason,
    message: string,
  ) {
    super(message);
    this.name = "ListUnavailableError";
    this.reason = reason;
    this.provider = source.provider;
    this.sourceRef = source.sourceRef;
  }
}

export interface ListFetchConfig {
  accountId: string;
  listId: string;
  provider: ProviderId;
  sourceRef: string;
  sort: CatalogSort;
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
  data: CatalogData;
  cachedAt: Date;
  generation: string | null;
}

interface InFlightRefresh {
  promise: Promise<FreshList>;
  /** Aborted when a newer read replaces this one: it must not write. */
  controller: AbortController;
}

const inFlightRefreshes = new Map<string, InFlightRefresh>();

/**
 * The Provider context of a Source list read. `connectionAccountId` is the
 * Account whose Connection the read may use, or null when the request may
 * not use one (a Legacy alias, a new setup).
 */
export async function providerContext(
  source: { provider: ProviderId; sourceRef: string },
  connectionAccountId: string | null,
): Promise<ProviderContext> {
  const connection = connectionAccountId
    ? await getConnectionAccess(connectionAccountId, source.provider)
    : null;
  if (
    !connection &&
    sourceRequiresConnection(source.provider, source.sourceRef)
  ) {
    throw new SourceUnavailableError(
      "needs_connection",
      `${source.provider} ${source.sourceRef} needs a Connection`,
    );
  }
  return { connection };
}

const LINK_BACK = /(?:^|\n\n)More on [^\n:]+: \S+$/u;

/**
 * Add "More on {Provider}: {url}" at the end of the description when the
 * entry has a page on its Provider. Idempotent: metadata reused from the
 * previous cache already carries it.
 */
function withLinkBack(
  meta: StremioMeta,
  entry: SourceEntry,
  provider: ProviderId,
): StremioMeta {
  if (!entry.sourceUrl) return meta;
  const base = meta.description.replace(LINK_BACK, "");
  const line = `More on ${PROVIDERS[provider].label}: ${entry.sourceUrl}`;
  return { ...meta, description: base ? `${base}\n\n${line}` : line };
}

export interface BuiltCatalog {
  data: CatalogData;
  /** Unresolved entries that no strategy tried yet. */
  deferred: number;
  /** Entries without an IMDb ID yet, in Source list order. */
  unresolvedEntries: SourceEntry[];
  /** Titles with an IMDb ID but no metadata, so they are not shown. */
  withoutMetadata: number;
}

/**
 * Turn a Provider snapshot into a canonical Catalog (provider order). Without
 * a `listId` (a preview of a List not saved yet), no cached metadata is reused.
 */
export async function buildCatalog(
  adapter: ProviderAdapter,
  config: Pick<
    ListFetchConfig,
    "provider" | "sourceRef" | "resolveBudgetMs"
  > & {
    listId?: string;
  },
  ctx: ProviderContext,
): Promise<BuiltCatalog> {
  const snapshot = await adapter.fetchSource(config.sourceRef, ctx);
  if (snapshot.entries.every((entry) => entry.meta)) {
    return {
      data: {
        metas: snapshot.entries.flatMap((entry) =>
          entry.meta ? [withLinkBack(entry.meta, entry, config.provider)] : [],
        ),
      },
      deferred: 0,
      unresolvedEntries: [],
      withoutMetadata: 0,
    };
  }

  const { resolved, unresolvedEntries, deferred } = await resolveEntries(
    adapter,
    snapshot.entries,
    { budgetMs: config.resolveBudgetMs ?? DEFAULT_RESOLVE_BUDGET_MS },
  );

  const previous = new Map<string, StremioMeta>();
  const cached = config.listId ? await getCachedList(config.listId) : null;
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
    metas.push(withLinkBack(meta, entry, config.provider));
  }

  if (unresolvedEntries.length > 0 || unknown > 0) {
    console.log(
      `List ${config.listId ?? "preview"} (${config.provider}): ${metas.length} titles, ${unresolvedEntries.length} unresolved entries (${deferred} not tried yet), ${unknown} without metadata`,
    );
  }
  return {
    data: { metas },
    deferred,
    unresolvedEntries,
    withoutMetadata: unknown,
  };
}

function freshnessOf(adapter: ProviderAdapter, sourceRef: string): number {
  return adapter.freshnessFor?.(sourceRef) ?? adapter.freshnessMs;
}

async function fetchAndCacheList(
  config: ListFetchConfig,
  signal: AbortSignal,
): Promise<FreshList> {
  const adapter = getProvider(config.provider);
  let connection: ConnectionAccess | null = null;
  // A read that a newer one replaced leaves no trace.
  const record = async (outcome: RefreshOutcome) => {
    if (!signal.aborted) {
      await recordRefreshOutcome(config, outcome, connection);
    }
  };

  let built: { data: CatalogData; deferred: number };
  try {
    if (!isProviderEnabled(config.provider)) {
      throw new SourceUnavailableError(
        "disabled",
        `${config.provider} is turned off`,
      );
    }
    const ctx = await providerContext(
      config,
      config.allowConnection ? config.accountId : null,
    );
    connection = ctx.connection;
    built = await buildCatalog(adapter, config, ctx);
  } catch (error) {
    await record({ kind: "failed", problem: sourceProblemReason(error) });
    throw error;
  }

  const { data, deferred } = built;
  const cachedAt = new Date();
  if (signal.aborted) return { data, cachedAt, generation: null };
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
    generation = await writeCachedList(config.listId, data, storedAt, config);
  } catch (error) {
    console.error(`Failed to cache list ${config.listId} in R2:`, error);
  }
  await record(
    generation === null
      ? { kind: "unsaved" }
      : { kind: "saved", titleCount: data.metas.length },
  );
  return { data, cachedAt, generation };
}

/**
 * One read per List and per access level at a time: a save can prewarm at
 * the same moment Stremio requests the Catalog. With `supersede`, a read in
 * flight is replaced instead of joined, because it may use an older
 * Connection; its late result must not replace the Catalog or the status of
 * the new one.
 */
function refreshList(
  config: ListFetchConfig,
  { supersede = false } = {},
): Promise<FreshList> {
  // The source is part of the key: a read started before an edit of the List
  // must not answer for its new Source list.
  const key = `${config.listId}:${config.provider}:${config.sourceRef}:${config.allowConnection ? "c" : "p"}`;
  const existing = inFlightRefreshes.get(key);
  if (existing && !supersede) return existing.promise;
  existing?.controller.abort();

  const controller = new AbortController();
  const refresh: InFlightRefresh = {
    promise: fetchAndCacheList(config, controller.signal),
    controller,
  };
  inFlightRefreshes.set(key, refresh);
  const clear = () => {
    if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key);
  };
  void refresh.promise.then(clear, clear);
  return refresh.promise;
}

function contentGeneration(listId: string, data: CatalogData): string {
  return `${listId}:${data.metas.map((meta) => `${meta.type}:${meta.id}`).join(",")}`;
}

function present(
  data: CatalogData,
  sort: CatalogSort,
  generation: string,
  rpdbApiKey?: string | null,
): CatalogData {
  return {
    metas: sortCatalog(data.metas, sort, generation).map((meta) => ({
      ...meta,
      poster: buildPosterUrl(meta.id, meta.poster, rpdbApiKey),
    })),
  };
}

/**
 * The reason of a failed Source list read. An expired Connection is an
 * expected state (the user revoked access): it asks to connect again instead
 * of a server error.
 */
export function sourceProblemReason(error: unknown): SourceProblemReason {
  if (error instanceof SourceUnavailableError) return error.reason;
  if (error instanceof ConnectionExpiredError) return "needs_connection";
  return "unavailable";
}

/**
 * The Titles of a List, sorted and with posters applied. Cache first; a stale
 * or empty cache triggers a Provider read; a failed read falls back to the
 * last non-empty cached Catalog.
 */
export async function getListCatalog(
  config: ListFetchConfig,
): Promise<CatalogData> {
  const adapter = getProvider(config.provider);
  const freshnessMs = freshnessOf(adapter, config.sourceRef);
  if (!config.forceFresh) {
    const cached = await getCachedList(config.listId, config);
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

    // A List that lost its Connection must not keep serving the private
    // items it cached while connected.
    const lostConnection = sourceProblemReason(error) === "needs_connection";
    if (!config.noCacheFallback && !lostConnection) {
      const cached = await getCachedList(config.listId, config);
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

    throw new ListUnavailableError(
      config,
      sourceProblemReason(error),
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

/**
 * After a disconnect: drop the cached Catalogs of the Account's Lists that
 * were read through that Connection, so nothing private stays served, and
 * their sync statuses, which described those Catalogs.
 */
export async function forgetConnectionLists(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const lists = (await getAccountLists(accountId)).filter(
    (list) =>
      list.provider === provider &&
      sourceRequiresConnection(list.provider, list.sourceRef),
  );
  await Promise.all([
    ...lists.map((list) => deleteCachedList(list.id)),
    forgetSyncStatuses(lists.map((list) => list.id)),
  ]);
}

/**
 * After a new authorization: read the Account's Lists on that Provider again,
 * so their Catalogs and sync statuses follow the new Connection at once
 * instead of at the next stale read.
 */
export async function rereadConnectionLists(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const lists = (await getAccountLists(accountId)).filter(
    (list) => list.provider === provider,
  );
  for (const list of lists) {
    try {
      await refreshList(
        {
          accountId,
          listId: list.id,
          provider: list.provider,
          sourceRef: list.sourceRef,
          sort: parseSortOption(list.sortOption),
          allowConnection: true,
          resolveBudgetMs: 25_000,
        },
        { supersede: true },
      );
    } catch (error) {
      console.error(
        `Failed to refresh list ${list.id} after connecting ${provider}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
