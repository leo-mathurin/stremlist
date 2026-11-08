import type { MergeableList } from "@stremlist/shared/list-merge";
import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { StremioMeta, CatalogData } from "@stremlist/shared/stremio.types";
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
import { listReadQueueMark } from "./read-queue";
import type { RefreshOutcome } from "./sync-status";
import { recordRefreshOutcome } from "./sync-status";

/**
 * When the ID resolver left entries untried, the next read comes this soon
 * instead of after the Provider's usual freshness.
 */
const RESUME_RESOLUTION_MS = 2 * 60_000;
/**
 * A Stremio request waits at most this long for a Catalog that it does not
 * have from a queued Provider (Letterboxd). The read goes on in the
 * background.
 */
const CATALOG_WAIT_MS = 10_000;
/** How long the background read after a Stremio request may wait its turn. */
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
  /** How an interactive read waits in a Provider queue (Letterboxd). */
  queue: QueuePolicy;
}

const READ_POLICIES: Record<ReadPolicy, ReadRules> = {
  // A Stremio catalog request.
  catalog: {
    forceFresh: false,
    noCacheFallback: false,
    marksAccount: true,
    resolveBudgetMs: DEFAULT_RESOLVE_BUDGET_MS,
    // Leaves time for ID resolution within the 10 s that Stremio waits.
    queue: { maxWaitMs: 8_000, partial: true },
  },
  // A background read after a save or a new Connection: it can resolve more
  // of a big cold list. Kept short because a catalog request for the same
  // List joins this read instead of starting its own.
  prewarm: {
    forceFresh: false,
    noCacheFallback: false,
    marksAccount: false,
    resolveBudgetMs: 25_000,
    queue: { maxWaitMs: 120_000, partial: true },
  },
  // The "Refresh now" button. The route marks the Account itself, once.
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
  rpdbApiKey: string | null;
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

/**
 * One Source list of a List, as a read handles it: `listId` stays the List
 * (its sync status is recorded there), `cacheKey` is where this Source list
 * keeps its cached Catalog (ADR 0006).
 */
interface SourceRead extends Omit<ListRead, "sort" | "rpdbApiKey"> {
  source: SourceId;
  listId: string;
  cacheKey: string;
  /** Interactive unless a cached Catalog can be served meanwhile. */
  priority?: ReadPriority;
  /** Overrides of the policy's queue rules, such as a kept ticket. */
  queue?: Partial<QueuePolicy>;
}

interface FreshList {
  data: SourceCatalogData;
  cachedAt: Date;
  generation: string | null;
  /** The read stopped early in the Provider's queue: it must go on soon. */
  interrupted: boolean;
  /** The read's place in the Provider's queue, for the read that goes on. */
  ticket: string | null;
}

interface InFlightRefresh {
  promise: Promise<FreshList>;
  policy: SourceRead["policy"];
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
): Promise<{ connection: OwnedConnectionAccess | null }> {
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
  meta: SourceMeta,
  entry: SourceEntry,
  provider: ProviderId,
): SourceMeta {
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

function freshnessOf(adapter: ProviderAdapter, sourceRef: string): number {
  return adapter.freshnessFor?.(sourceRef) ?? adapter.freshnessMs;
}

/**
 * Read a Source list and cache its Catalog. An interactive read waits in
 * the Provider's queue by the rules of its policy.
 */
async function fetchAndCacheList(
  read: SourceRead,
  signal: AbortSignal,
): Promise<FreshList> {
  const rules = READ_POLICIES[read.policy];
  // A background read after a save shows its queue estimate on the
  // configure page.
  const mark =
    read.policy === "prewarm"
      ? listReadQueueMark({ ...read.source, listId: read.listId })
      : null;
  const policy = { ...rules.queue, ...read.queue };
  const queue = readQueue({
    ...policy,
    // A background read never replaces a cached Catalog with fewer pages:
    // when the queue is long, it stops and the cache stays.
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
): Promise<FreshList> {
  const { source, cacheKey } = read;
  const adapter = getProvider(source.provider);
  const rules = READ_POLICIES[read.policy];
  let connection: OwnedConnectionAccess | null = null;
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
    // A read that waits its turn has not failed: the List keeps its status.
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
  // Back-date the cache so the next request resumes resolution, or a read
  // that stopped in the Provider's queue, soon.
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
  return { data, cachedAt, generation, ...resume };
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
): InFlightRefresh {
  // The source is part of the key: a read started before an edit of the List
  // must not answer for its new Source list.
  const key = `${read.cacheKey}:${read.source.provider}:${read.source.sourceRef}:${read.allowConnection ? "c" : "p"}`;
  const existing = inFlightRefreshes.get(key);
  const revalidate = read.policy === "manual" && existing?.policy !== "manual";
  if (existing && !supersede && !revalidate) return existing;
  existing?.controller.abort();

  const controller = new AbortController();
  const refresh: InFlightRefresh = {
    // Let any previous write settle before a forced read can publish its result.
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

/**
 * After a Stremio read that stopped in the Provider's queue, go on in the
 * background with the same place in the queue, so the List is complete in a
 * few minutes. Only a Stremio read goes on; a read that joined one does not
 * start another.
 */
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

/** A Stremio request stops waiting for a read after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
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
  // A Stremio request for a Provider that queues its reads waits less.
  const queued = adapter.queuedReads === true && read.policy === "catalog";
  // A stale Catalog that can still be served makes the read a background one.
  let servable = false;
  if (!rules.forceFresh) {
    const cached = await getCachedList(cacheKey, source);
    servable = !rules.noCacheFallback && (cached?.data.metas.length ?? 0) > 0;
    // An empty cache is not a hit: it cannot be told apart from "the list
    // became private", which must surface its reason.
    if (
      cached &&
      cached.data.metas.length > 0 &&
      Date.now() - cached.cachedAt.getTime() < freshnessMs
    ) {
      return { data: cached.data, generation: cached.generation, readAt: null };
    }
    // Serve the stale Catalog at once and read in the background.
    if (cached && servable && queued) {
      const refresh = refreshList({ ...read, priority: "background" });
      scheduleBackgroundTask(() =>
        refresh.promise.catch(async (error: unknown) => {
          // A busy Provider refuses background reads: the next request tries again.
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
    // Waiting in a Provider's queue is expected, not an error.
    (error instanceof SourceBusyError ? console.warn : console.error)(
      `Reading list ${cacheKey} (${source.provider}) failed, trying cache:`,
      message,
    );

    // A Source list the Provider no longer shows must not keep serving the
    // Titles it cached before: a List that lost its Connection, or a
    // Letterboxd list that is gone, turned private, or whose Share link was
    // revoked (HTTP 404, mapped to not_found).
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

/**
 * A Letterboxd list that is gone, turned private, or whose Share link was
 * revoked (HTTP 404, mapped to not_found): drop its cached Catalog so its
 * Titles cannot come back on a later read, even one served from a
 * still-fresh cache. The shared page snapshot is cleared by the adapter on
 * the same 404. Returns whether the Catalog was revoked.
 */
async function forgetRevokedCatalog(
  source: SourceId,
  cacheKey: string,
  error: unknown,
): Promise<boolean> {
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
        .map(({ source, cacheKey }) =>
          findCachedMeta(cacheKey, type, id, source),
        ),
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
