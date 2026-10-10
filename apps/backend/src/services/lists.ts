import type { MergeableList } from "@stremlist/shared/list-merge";
import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { StremioMeta, CatalogData } from "@stremlist/shared/stremio.types";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type {
  ConnectionAccess,
  ProviderAdapter,
  ProviderContext,
  SourceEntry,
  SourceSnapshot,
} from "../providers/types";
import {
  ConnectionExpiredError,
  SourceUnavailableError,
} from "../providers/types";
import { enrichTitles } from "../titles/enrich";
import { DEFAULT_RESOLVE_BUDGET_MS, resolveEntries } from "../titles/resolver";
import type { AccountAccess } from "./accounts";
import {
  getAccountLists,
  getVisibleLists,
  markAccountFetched,
} from "./accounts";
import { forgetConnectionObjects } from "./actions";
import type { CatalogSort } from "./catalog-sort";
import { sortCatalog } from "./catalog-sort";
import { deleteConnection, getConnectionAccess } from "./connections";
import { recordSynchronization } from "./detections";
import { buildPosterUrl } from "./imdb-scraper";
import {
  deleteCachedList,
  findCachedMeta,
  getCachedList,
  writeCachedList,
} from "./list-cache";
import type { SourceCatalogData, SourceMeta } from "./list-cache";
import {
  mergeListCatalogs,
  mergeSourceCatalogs,
  sourceCaches,
  toStremioMeta,
  withLinkBack,
} from "./merged-lists";
import type { RefreshOutcome } from "./sync-status";
import { recordRefreshOutcome } from "./sync-status";

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

  constructor(source: SourceId, reason: SourceProblemReason, message: string) {
    super(message);
    this.name = "ListUnavailableError";
    this.reason = reason;
    this.provider = source.provider;
    this.sourceRef = source.sourceRef;
  }
}

/**
 * Why a List is read. Each policy is one row of `READ_POLICIES`, so the
 * rules that go together are set together.
 */
type ReadPolicy = "catalog" | "prewarm" | "manual";

interface ReadRules {
  /** Read the Provider even when the cached Catalog is fresh. */
  forceFresh: boolean;
  /**
   * A failed read is not masked by the existing cache: the error is rethrown
   * so the manual refresh can report it honestly.
   */
  noCacheFallback: boolean;
  /** A Provider read marks when the Account was read (`last_fetched_at`). */
  marksAccount: boolean;
  /** Time the ID resolver may spend on entries without an IMDb ID. */
  resolveBudgetMs: number;
}

const READ_POLICIES: Record<ReadPolicy, ReadRules> = {
  // A Stremio catalog request.
  catalog: {
    forceFresh: false,
    noCacheFallback: false,
    marksAccount: true,
    resolveBudgetMs: DEFAULT_RESOLVE_BUDGET_MS,
  },
  // A background read after a save or a new Connection: it can resolve more
  // of a big cold list. Kept short because a catalog request for the same
  // List joins this read instead of starting its own.
  prewarm: {
    forceFresh: false,
    noCacheFallback: false,
    marksAccount: false,
    resolveBudgetMs: 25_000,
  },
  // The "Refresh now" button. The route marks the Account itself, once.
  manual: {
    forceFresh: true,
    noCacheFallback: true,
    marksAccount: false,
    resolveBudgetMs: DEFAULT_RESOLVE_BUDGET_MS,
  },
};

/** How a request reads the Lists of an Account. */
export interface ListRead {
  accountId: string;
  sort: CatalogSort;
  rpdbApiKey: string | null;
  /**
   * Whether this request may read through the Account's Connection. False for
   * requests that come through a Legacy alias (ADR 0001).
   */
  allowConnection: boolean;
  policy: ReadPolicy;
}

/** The List fields that a read needs. */
type ReadableList = MergeableList & { id: string };

/**
 * One Source list of a List, as a read handles it: `listId` stays the List
 * (its sync status is recorded there), `cacheKey` is where this Source list
 * keeps its cached Catalog (ADR 0006).
 */
interface SourceRead extends Omit<ListRead, "sort" | "rpdbApiKey"> {
  source: SourceId;
  listId: string;
  cacheKey: string;
}

interface FreshList {
  data: SourceCatalogData;
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
  source: SourceId,
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

/**
 * The cached form of an entry: its meta with the link back and the date it
 * joined the Source list (metadata reused from the previous cache may carry
 * an older date).
 */
function toSourceMeta(
  meta: StremioMeta,
  entry: SourceEntry,
  provider: ProviderId,
): SourceMeta {
  const linked: SourceMeta = toStremioMeta(
    withLinkBack(meta, provider, entry.sourceUrl),
  );
  const time = entry.addedAt ? Date.parse(entry.addedAt) : Number.NaN;
  return Number.isFinite(time)
    ? { ...linked, addedAt: new Date(time).toISOString() }
    : linked;
}

export interface BuiltCatalog {
  data: SourceCatalogData;
  /** Unresolved entries that no strategy tried yet. */
  deferred: number;
  /** Entries without an IMDb ID yet, in Source list order. */
  unresolvedEntries: SourceEntry[];
  /** Titles with an IMDb ID but no metadata, so they are not shown. */
  withoutMetadata: number;
  /** The Provider read, cut short or not. */
  snapshot: SourceSnapshot;
  /** The IMDb ID of each resolved entry. */
  imdbIds: ReadonlyMap<SourceEntry, string>;
}

/**
 * Turn a Provider snapshot into a canonical Catalog (provider order). Without
 * a `cacheKey` (a preview), no cached metadata is reused.
 */
export async function buildCatalog(
  adapter: ProviderAdapter,
  config: SourceId & {
    /** Where the Source list keeps its cached Catalog. */
    cacheKey?: string;
    /** Time the ID resolver may spend on entries without an IMDb ID. */
    resolveBudgetMs?: number;
  },
  ctx: ProviderContext,
): Promise<BuiltCatalog> {
  const snapshot = await adapter.fetchSource(config.sourceRef, ctx);
  if (snapshot.entries.every((entry) => entry.meta)) {
    return {
      data: {
        metas: snapshot.entries.flatMap((entry) =>
          entry.meta ? [toSourceMeta(entry.meta, entry, config.provider)] : [],
        ),
      },
      deferred: 0,
      unresolvedEntries: [],
      withoutMetadata: 0,
      snapshot,
      imdbIds: new Map(
        snapshot.entries.flatMap((entry) =>
          entry.meta ? [[entry, entry.meta.id] as const] : [],
        ),
      ),
    };
  }

  const { resolved, unresolvedEntries, deferred } = await resolveEntries(
    adapter,
    snapshot.entries,
    { budgetMs: config.resolveBudgetMs ?? DEFAULT_RESOLVE_BUDGET_MS },
  );

  const previous = new Map<string, StremioMeta>();
  const cached = config.cacheKey ? await getCachedList(config.cacheKey) : null;
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
  const metas: SourceMeta[] = [];
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
    metas.push(toSourceMeta(meta, entry, config.provider));
  }

  if (unresolvedEntries.length > 0 || unknown > 0) {
    console.log(
      `List ${config.cacheKey ?? "preview"} (${config.provider}): ${metas.length} titles, ${unresolvedEntries.length} unresolved entries (${deferred} not tried yet), ${unknown} without metadata`,
    );
  }
  return {
    data: { metas },
    deferred,
    unresolvedEntries,
    withoutMetadata: unknown,
    snapshot,
    imdbIds: new Map(resolved.map(({ entry, imdbId }) => [entry, imdbId])),
  };
}

function freshnessOf(adapter: ProviderAdapter, sourceRef: string): number {
  return adapter.freshnessFor?.(sourceRef) ?? adapter.freshnessMs;
}

async function fetchAndCacheList(
  read: SourceRead,
  signal: AbortSignal,
): Promise<FreshList> {
  const { source, cacheKey } = read;
  const adapter = getProvider(source.provider);
  let connection: ConnectionAccess | null = null;
  // A read that a newer one replaced leaves no trace.
  const record = async (outcome: RefreshOutcome) => {
    if (!signal.aborted) {
      await recordRefreshOutcome(
        { ...source, listId: read.listId },
        outcome,
        connection,
      );
    }
  };

  // Taken before the read: when two reads overlap, the history keeps the
  // one that started last.
  const startedAt = new Date();
  let built: BuiltCatalog;
  try {
    if (!isProviderEnabled(source.provider)) {
      throw new SourceUnavailableError(
        "disabled",
        `${source.provider} is turned off`,
      );
    }
    const ctx = await providerContext(
      source,
      read.allowConnection ? read.accountId : null,
    );
    connection = ctx.connection;
    built = await buildCatalog(
      adapter,
      {
        ...source,
        cacheKey,
        resolveBudgetMs: READ_POLICIES[read.policy].resolveBudgetMs,
      },
      ctx,
    );
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
              freshnessOf(adapter, source.sourceRef) - RESUME_RESOLUTION_MS,
              0,
            ),
        )
      : cachedAt;
  let generation: string | null = null;
  try {
    generation = await writeCachedList(cacheKey, data, storedAt, source);
  } catch (error) {
    console.error(`Failed to cache list ${cacheKey} in R2:`, error);
  }
  await record(
    generation === null
      ? { kind: "unsaved" }
      : { kind: "saved", titleCount: data.metas.length },
  );
  // A read cut short is served, but never compared (ADR 0007).
  if (built.snapshot.complete) {
    await recordSynchronization(
      { ...source, accountId: read.accountId, listId: read.listId },
      adapter,
      built.snapshot.entries,
      built.imdbIds,
      { startedAt, connectionUser: connection?.username ?? null },
    );
  }
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
  read: SourceRead,
  { supersede = false } = {},
): Promise<FreshList> {
  // The source is part of the key: a read started before an edit of the List
  // must not answer for its new Source list.
  const key = `${read.cacheKey}:${read.source.provider}:${read.source.sourceRef}:${read.allowConnection ? "c" : "p"}`;
  const existing = inFlightRefreshes.get(key);
  if (existing && !supersede) return existing.promise;
  existing?.controller.abort();

  const controller = new AbortController();
  const refresh: InFlightRefresh = {
    promise: fetchAndCacheList(read, controller.signal),
    controller,
  };
  inFlightRefreshes.set(key, refresh);
  const clear = () => {
    if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key);
  };
  void refresh.promise.then(clear, clear);
  return refresh.promise;
}

function contentGeneration(listId: string, data: SourceCatalogData): string {
  return `${listId}:${data.metas.map((meta) => `${meta.type}:${meta.id}`).join(",")}`;
}

function present(
  data: SourceCatalogData,
  sort: CatalogSort,
  generation: string,
  rpdbApiKey?: string | null,
): CatalogData {
  return {
    metas: sortCatalog(data.metas, sort, generation).map((meta) => ({
      ...toStremioMeta(meta),
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

/** The canonical Catalog of one Source list, before sorting and posters. */
interface SourceCatalog {
  data: SourceCatalogData;
  generation: string;
  /** When this call read the Provider; null when the cache answered. */
  readAt: Date | null;
}

/**
 * The canonical Catalog of one Source list. Cache first; a stale or empty
 * cache triggers a Provider read; a failed read falls back to the last
 * non-empty cached Catalog. The caller marks when the Account was read.
 */
async function readSourceCatalog(read: SourceRead): Promise<SourceCatalog> {
  const { source, cacheKey } = read;
  const rules = READ_POLICIES[read.policy];
  const adapter = getProvider(source.provider);
  const freshnessMs = freshnessOf(adapter, source.sourceRef);
  if (!rules.forceFresh) {
    const cached = await getCachedList(cacheKey, source);
    // An empty cache is not a hit: it cannot be told apart from "the list
    // became private", which must surface its reason.
    if (
      cached &&
      cached.data.metas.length > 0 &&
      Date.now() - cached.cachedAt.getTime() < freshnessMs
    ) {
      return { data: cached.data, generation: cached.generation, readAt: null };
    }
  }

  try {
    const fresh = await refreshList(read);
    return {
      data: fresh.data,
      generation: fresh.generation ?? contentGeneration(cacheKey, fresh.data),
      readAt: fresh.cachedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Reading list ${cacheKey} (${source.provider}) failed, trying cache:`,
      message,
    );

    // A List that lost its Connection must not keep serving the private
    // items it cached while connected.
    const lostConnection = sourceProblemReason(error) === "needs_connection";
    if (!rules.noCacheFallback && !lostConnection) {
      const cached = await getCachedList(cacheKey, source);
      if (cached && cached.data.metas.length > 0) {
        await markAccountFetched(read.accountId, "last_cache_served_at");
        return {
          data: cached.data,
          generation: cached.generation,
          readAt: null,
        };
      }
    }

    throw new ListUnavailableError(
      source,
      sourceProblemReason(error),
      `Failed to read list ${cacheKey} and no cache available: ${message}`,
    );
  }
}

/**
 * The Titles of a List, sorted and with posters applied. Each Source list is
 * read and cached on its own (a List with one Source list has only one), and
 * a merged List shows their Titles once each (ADR 0006). A Source list that
 * cannot be served is left out, so the others still show; the List fails
 * only when none can be served, or on a manual refresh when any of them
 * fails.
 */
export async function getListCatalog(
  list: ReadableList,
  read: ListRead,
): Promise<CatalogData> {
  const rules = READ_POLICIES[read.policy];
  const results = await Promise.allSettled(
    sourceCaches(list).map(({ source, cacheKey }) =>
      readSourceCatalog({
        accountId: read.accountId,
        allowConnection: read.allowConnection,
        policy: read.policy,
        listId: list.id,
        source: { provider: source.provider, sourceRef: source.sourceRef },
        cacheKey,
      }),
    ),
  );
  const catalogs: SourceCatalog[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") catalogs.push(result.value);
    else failures.push(result.reason);
  }
  if (catalogs.length === 0 || (rules.noCacheFallback && failures.length > 0)) {
    throw failures[0];
  }
  if (failures.length > 0) {
    console.warn(
      `List ${list.id}: ${failures.length} of ${results.length} Source lists left out of the merged Catalog`,
    );
  }

  const readAt = catalogs.reduce<Date | null>(
    (latest, { readAt }) =>
      readAt && (!latest || readAt > latest) ? readAt : latest,
    null,
  );
  if (readAt && rules.marksAccount) {
    await markAccountFetched(read.accountId, "last_fetched_at", readAt);
  }
  return present(
    {
      metas: mergeListCatalogs(
        list,
        catalogs.map((catalog) => catalog.data.metas),
      ),
    },
    read.sort,
    catalogs.map((catalog) => catalog.generation).join("|"),
    read.rpdbApiKey,
  );
}

/**
 * One Title's metadata for a Stremio detail page, from the cache only: never
 * a Provider read, never a write, never a throw. A miss answers null so
 * Stremio falls back to Cinemeta. (The old per-request fan-out that re-read
 * stale lists caused the production 500/504 storm on /meta.)
 */
export async function findMetaInAccountCache(
  access: AccountAccess,
  type: string,
  id: string,
): Promise<StremioMeta | null> {
  try {
    const lists = await getVisibleLists(access);
    // Every cached copy, so the detail page keeps the link back of each
    // Source list that has the Title, as its catalog card does.
    const copies = await Promise.all(
      lists
        .flatMap(sourceCaches)
        .map(({ cacheKey }) => findCachedMeta(cacheKey, type, id)),
    );
    const found = mergeSourceCatalogs(
      [copies.filter((copy) => copy !== null)],
      false,
    ).at(0);
    if (!found) return null;
    return {
      ...toStremioMeta(found),
      poster: buildPosterUrl(found.id, found.poster, access.account.rpdbApiKey),
    };
  } catch (error) {
    console.error(
      `findMetaInAccountCache failed for ${access.account.id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Disconnect a Provider. The token is revoked, then the Connection goes in
 * one transaction with its detection history and the sync statuses of the
 * Source lists read through it (`deleteConnection`). Then their cached
 * Catalogs and the Connection's own R2 objects are deleted, so nothing
 * private stays served or stored; a failed deletion is logged. The other
 * Source lists of a merged List keep their cache and status.
 */
export async function disconnectProvider(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const sources = (await getAccountLists(accountId)).flatMap((list) =>
    sourceCaches(list)
      .filter(
        ({ source }) =>
          source.provider === provider &&
          sourceRequiresConnection(source.provider, source.sourceRef),
      )
      .map(({ source, cacheKey }) => ({
        sourceRef: source.sourceRef,
        cacheKey,
        listId: list.id,
      })),
  );
  await deleteConnection(accountId, provider, sources);
  const cleanup = await Promise.allSettled([
    ...sources.map(({ cacheKey }) => deleteCachedList(cacheKey)),
    forgetConnectionObjects(accountId, provider),
  ]);
  for (const outcome of cleanup) {
    if (outcome.status === "rejected") {
      console.error(
        `Cleaning up after the ${provider} disconnect of ${accountId} failed:`,
        outcome.reason,
      );
    }
  }
}

/**
 * After a new authorization: read the Source lists of the Account's Lists on
 * that Provider again, so their Catalogs and sync statuses follow the new
 * Connection at once instead of at the next stale read.
 */
export async function rereadConnectionLists(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  for (const list of await getAccountLists(accountId)) {
    for (const { source, cacheKey } of sourceCaches(list)) {
      if (source.provider !== provider) continue;
      try {
        await refreshList(
          {
            accountId,
            listId: list.id,
            cacheKey,
            source: { provider: source.provider, sourceRef: source.sourceRef },
            allowConnection: true,
            policy: "prewarm",
          },
          { supersede: true },
        );
      } catch (error) {
        console.error(
          `Failed to refresh list ${cacheKey} after connecting ${provider}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
