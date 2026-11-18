import type { MergeableList } from "@stremlist/shared/list-merge";
import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { scheduleBackgroundTask } from "../lib/background";
import type {
  QueuePolicy,
  ReadPriority,
  ReadQueue,
} from "../providers/read-priority";
import { readQueue, withReadPriority } from "../providers/read-priority";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type {
  ProviderAdapter,
  ProviderContext,
  SourceEntry,
  SourceSnapshot,
} from "../providers/types";
import {
  ConnectionExpiredError,
  SourceBusyError,
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
import { isCurrentConnection } from "./connection-identity";
import { deleteConnection, getConnectionAccess } from "./connections";
import type { OwnedConnectionAccess } from "./connections";
import { recordSynchronization } from "./detections";
import { withAccountPosters } from "./posters";
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
import { listReadQueueMark } from "./read-queue";
import type { RefreshOutcome } from "./sync-status";
import { recordRefreshOutcome } from "./sync-status";
import { deleteState } from "./watch/state";
import { isTrackedNow } from "./watch/tracking";

const RESUME_RESOLUTION_MS = 2 * 60_000;
const CATALOG_WAIT_MS = 10_000;
const CONTINUATION_WAIT_MS = 200_000;

/**
 * Thrown when a List cannot be served at all: the Provider read failed and no
 * cached Catalog is available. Every reason except "unavailable" is an
 * expected state shown as an information card.
 */
export class ListUnavailableError extends Error {
  readonly reason: SourceProblemReason;
  readonly provider: ProviderId;
  readonly sourceRef: string;
  /**
   * The Provider's request queue is long and the read goes on in the
   * background: the List shows soon.
   */
  readonly queued: boolean;

  constructor(
    source: SourceId,
    reason: SourceProblemReason,
    message: string,
    { queued = false } = {},
  ) {
    super(message);
    this.name = "ListUnavailableError";
    this.reason = reason;
    this.provider = source.provider;
    this.sourceRef = source.sourceRef;
    this.queued = queued;
  }
}

/**
 * Why a List is read. Each policy is one row of `READ_POLICIES`, so the
 * rules that go together are set together.
 */
type ReadPolicy = "catalog" | "prewarm" | "manual";

interface ReadRules {
  forceFresh: boolean;
  noCacheFallback: boolean;
  marksAccount: boolean;
  resolveBudgetMs: number;
  queue: QueuePolicy;
}

const READ_POLICIES: Record<ReadPolicy, ReadRules> = {
  catalog: {
    forceFresh: false,
    noCacheFallback: false,
    marksAccount: true,
    resolveBudgetMs: DEFAULT_RESOLVE_BUDGET_MS,
    queue: { maxWaitMs: 8_000, partial: true },
  },
  prewarm: {
    forceFresh: false,
    noCacheFallback: false,
    marksAccount: false,
    resolveBudgetMs: 25_000,
    queue: { maxWaitMs: 120_000, partial: true },
  },
  manual: {
    forceFresh: true,
    noCacheFallback: true,
    marksAccount: false,
    resolveBudgetMs: DEFAULT_RESOLVE_BUDGET_MS,
    queue: { maxWaitMs: 10_000 },
  },
};

/** How a request reads the Lists of an Account. */
export interface ListRead {
  accountId: string;
  sort: CatalogSort;
  /**
   * Whether this request may read through the Account's Connection. False for
   * requests that come through a Legacy alias (ADR 0001).
   */
  allowConnection: boolean;
  policy: ReadPolicy;
  /** No read waits in a Provider queue past this time (epoch ms). */
  queueDeadline?: number;
}

/** The List fields that a read needs. */
type ReadableList = MergeableList & { id: string };

interface SourceRead extends Omit<ListRead, "sort"> {
  source: SourceId;
  listId: string;
  cacheKey: string;
  priority?: ReadPriority;
  queue?: Partial<QueuePolicy>;
}

interface FreshList {
  data: SourceCatalogData;
  cachedAt: Date;
  generation: string | null;
  interrupted: boolean;
  ticket: string | null;
}

interface InFlightRefresh {
  promise: Promise<FreshList>;
  policy: SourceRead["policy"];
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
) {
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

function toSourceMeta(
  meta: SourceMeta,
  entry: SourceEntry,
  provider: ProviderId,
) {
  const linked: SourceMeta = {
    ...toStremioMeta(withLinkBack(meta, provider, entry.sourceUrl)),
    enrichedAt: meta.enrichedAt ?? new Date().toISOString(),
  };
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
) {
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

  const previous = new Map<string, SourceMeta>();
  const cached = config.cacheKey
    ? await getCachedList(config.cacheKey, config)
    : null;
  if (cached) {
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

function freshnessOf(adapter: ProviderAdapter, sourceRef: string) {
  return adapter.freshnessFor?.(sourceRef) ?? adapter.freshnessMs;
}

async function fetchAndCacheList(read: SourceRead, signal: AbortSignal) {
  const rules = READ_POLICIES[read.policy];
  const mark =
    read.policy === "prewarm"
      ? listReadQueueMark({ ...read.source, listId: read.listId })
      : null;
  const policy = { ...rules.queue, ...read.queue };
  const queue = readQueue({
    ...policy,
    partial: policy.partial === true && read.priority !== "background",
    maxWaitMs: Math.min(
      policy.maxWaitMs,
      Math.max(0, (read.queueDeadline ?? Infinity) - Date.now()),
    ),
    onQueued: mark
      ? (waitMs) => {
          mark.queued(waitMs);
        }
      : undefined,
  });
  try {
    return await readAndCacheList(read, signal, queue);
  } finally {
    await mark?.done();
  }
}

async function readAndCacheList(
  read: SourceRead,
  signal: AbortSignal,
  queue: ReadQueue,
) {
  const { source, cacheKey } = read;
  const adapter = getProvider(source.provider);
  const rules = READ_POLICIES[read.policy];
  let connection: OwnedConnectionAccess | null = null;
  const record = async (outcome: RefreshOutcome) => {
    if (!signal.aborted) {
      await recordRefreshOutcome(
        { ...source, listId: read.listId },
        outcome,
        connection,
      );
    }
  };

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
    built = await withReadPriority(
      read.priority ?? "interactive",
      () =>
        buildCatalog(
          adapter,
          {
            ...source,
            cacheKey,
            resolveBudgetMs: rules.resolveBudgetMs,
          },
          read.policy === "manual" ? { ...ctx, forceRefresh: true } : ctx,
        ),
      queue,
    );
  } catch (error) {
    if (!(error instanceof SourceBusyError))
      await record({ kind: "failed", problem: sourceProblemReason(error) });
    throw error;
  }

  if (connection && !(await isCurrentConnection(connection.identity))) {
    throw new ConnectionExpiredError(source.provider);
  }
  const { data, deferred } = built;
  const cachedAt = new Date();
  const interrupted = built.snapshot.interrupted === true;
  const resume = { interrupted, ticket: queue.ticket };
  if (signal.aborted) return { data, cachedAt, generation: null, ...resume };
  const storedAt =
    deferred > 0 || interrupted
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
    generation = await writeCachedList(
      cacheKey,
      data,
      storedAt,
      source,
      connection?.identity,
    );
  } catch (error) {
    console.error(`Failed to cache list ${cacheKey} in R2:`, error);
  }
  await record(
    generation === null
      ? { kind: "unsaved" }
      : { kind: "saved", titleCount: data.metas.length },
  );
  if (built.snapshot.complete) {
    await recordSynchronization(
      { ...source, accountId: read.accountId, listId: read.listId },
      adapter,
      built.snapshot.entries,
      built.imdbIds,
      { startedAt, connectionUser: connection?.username ?? null },
    );
  }
  return { data, cachedAt, generation, ...resume };
}

function refreshList(read: SourceRead, { supersede = false } = {}) {
  const key = `${read.cacheKey}:${read.source.provider}:${read.source.sourceRef}:${read.allowConnection ? "c" : "p"}`;
  const existing = inFlightRefreshes.get(key);
  const revalidate = read.policy === "manual" && existing?.policy !== "manual";
  if (existing && !supersede && !revalidate) return existing;
  existing?.controller.abort();

  const controller = new AbortController();
  const refresh: InFlightRefresh = {
    promise:
      existing && revalidate
        ? existing.promise
            .catch(() => undefined)
            .then(() => fetchAndCacheList(read, controller.signal))
        : fetchAndCacheList(read, controller.signal),
    policy: read.policy,
    controller,
  };
  inFlightRefreshes.set(key, refresh);
  const clear = () => {
    if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key);
  };
  void refresh.promise.then(clear, clear);
  return refresh;
}

function continueInBackground(read: SourceRead, refresh: InFlightRefresh) {
  if (refresh.policy !== "catalog") return;
  scheduleBackgroundTask(async () => {
    const stopped = await refresh.promise.then(
      (fresh) => (fresh.interrupted ? { ticket: fresh.ticket } : null),
      (error: unknown) =>
        error instanceof SourceBusyError ? { ticket: error.ticket } : null,
    );
    if (!stopped) return;
    try {
      await refreshList({
        ...read,
        policy: "prewarm",
        priority: "interactive",
        queue: { maxWaitMs: CONTINUATION_WAIT_MS, ticket: stopped.ticket },
      }).promise;
    } catch (error) {
      console.warn(
        `The background read of list ${read.cacheKey} (${read.source.provider}) stopped:`,
        error instanceof Error ? error.message : error,
      );
    }
  });
}

async function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SourceBusyError(ms, {}, "The read goes on"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function contentGeneration(listId: string, data: SourceCatalogData) {
  return `${listId}:${data.metas.map((meta) => `${meta.type}:${meta.id}`).join(",")}`;
}

function present(
  data: SourceCatalogData,
  sort: CatalogSort,
  generation: string,
) {
  return {
    metas: sortCatalog(data.metas, sort, generation).map(toStremioMeta),
  };
}

/**
 * The reason of a failed Source list read. An expired Connection is an
 * expected state (the user revoked access): it asks to connect again instead
 * of a server error.
 */
export function sourceProblemReason(error: unknown) {
  if (error instanceof SourceUnavailableError) return error.reason;
  if (error instanceof ConnectionExpiredError) return "needs_connection";
  return "unavailable";
}

interface SourceCatalog {
  data: SourceCatalogData;
  generation: string;
  readAt: Date | null;
}

async function readSourceCatalog(read: SourceRead) {
  const { source, cacheKey } = read;
  const rules = READ_POLICIES[read.policy];
  const adapter = getProvider(source.provider);
  const freshnessMs = freshnessOf(adapter, source.sourceRef);
  const queued = adapter.queuedReads === true && read.policy === "catalog";
  let servable = false;
  if (!rules.forceFresh) {
    const cached = await getCachedList(cacheKey, source);
    servable = !rules.noCacheFallback && (cached?.data.metas.length ?? 0) > 0;
    if (
      cached &&
      cached.data.metas.length > 0 &&
      Date.now() - cached.cachedAt.getTime() < freshnessMs
    ) {
      return { data: cached.data, generation: cached.generation, readAt: null };
    }
    if (cached && servable && queued) {
      const refresh = refreshList({ ...read, priority: "background" });
      scheduleBackgroundTask(() =>
        refresh.promise.catch(async (error: unknown) => {
          if (error instanceof SourceBusyError) return;
          if (await forgetRevokedCatalog(source, cacheKey, error)) return;
          console.warn(
            `Refreshing list ${cacheKey} (${source.provider}) in the background failed:`,
            error instanceof Error ? error.message : error,
          );
        }),
      );
      await markAccountFetched(read.accountId, "last_cache_served_at");
      return { data: cached.data, generation: cached.generation, readAt: null };
    }
  }

  try {
    const refresh = refreshList({
      ...read,
      priority: servable ? "background" : "interactive",
    });
    if (queued) continueInBackground(read, refresh);
    const fresh = await (queued
      ? within(refresh.promise, CATALOG_WAIT_MS)
      : refresh.promise);
    return {
      data: fresh.data,
      generation: fresh.generation ?? contentGeneration(cacheKey, fresh.data),
      readAt: fresh.cachedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (error instanceof SourceBusyError ? console.warn : console.error)(
      `Reading list ${cacheKey} (${source.provider}) failed, trying cache:`,
      message,
    );

    const reason = sourceProblemReason(error);
    const revoked = await forgetRevokedCatalog(source, cacheKey, error);
    const providerDropped = reason === "needs_connection" || revoked;
    if (!rules.noCacheFallback && !providerDropped) {
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
      { queued: error instanceof SourceBusyError },
    );
  }
}

async function forgetRevokedCatalog(
  source: SourceId,
  cacheKey: string,
  error: unknown,
) {
  if (
    source.provider !== "letterboxd" ||
    sourceProblemReason(error) !== "not_found"
  )
    return false;
  await deleteCachedList(cacheKey).catch((deleteError: unknown) => {
    console.error(
      `Clearing the revoked Catalog ${cacheKey} failed:`,
      deleteError instanceof Error ? deleteError.message : deleteError,
    );
  });
  return true;
}

/**
 * The Titles of a List, sorted, with the posters of their metadata: the
 * caller applies the Account's poster settings (`withAccountPosters`) to
 * what it serves. Each Source list is
 * read and cached on its own (a List with one Source list has only one), and
 * a merged List shows their Titles once each (ADR 0006). A Source list that
 * cannot be served is left out, so the others still show; the List fails
 * only when none can be served, or on a manual refresh when any of them
 * fails.
 */
export async function getListCatalog(list: ReadableList, read: ListRead) {
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
        queueDeadline: read.queueDeadline,
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
) {
  try {
    const lists = await getVisibleLists(access);
    const copies = await Promise.all(
      lists
        .flatMap(sourceCaches)
        .map(({ source, cacheKey }) =>
          findCachedMeta(cacheKey, type, id, source),
        ),
    );
    const found = mergeSourceCatalogs(
      [copies.filter((copy) => copy !== null)],
      false,
    ).at(0);
    if (!found) return null;
    const [meta] = await withAccountPosters(
      [toStremioMeta(found)],
      access.account,
    );
    return meta;
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
) {
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
    isTrackedNow(accountId).then((tracked) =>
      tracked ? undefined : deleteState(accountId),
    ),
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
) {
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
        ).promise;
      } catch (error) {
        console.error(
          `Failed to refresh list ${cacheKey} after connecting ${provider}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
