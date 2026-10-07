import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { StremioMeta, CatalogData } from "@stremlist/shared/stremio.types";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type {
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
import { recordRefreshOutcome, reportConnectionWorking } from "./sync-status";

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
  /**
   * Start a new read even when one is in flight, because that one may use
   * an older Connection (the read right after a new authorization).
   */
  freshRead?: boolean;
}

interface FreshList {
  data: CatalogData;
  cachedAt: Date;
  generation: string | null;
}

interface InFlightRefresh {
  promise: Promise<FreshList>;
  /** A newer read replaced this one (`freshRead`); it must not write. */
  state: { superseded: boolean };
}

const inFlightRefreshes = new Map<string, InFlightRefresh>();

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

/** Turn a Provider snapshot into a canonical Catalog (provider order). */
async function buildCatalog(
  adapter: ProviderAdapter,
  config: ListFetchConfig,
  ctx: ProviderContext,
): Promise<{ data: CatalogData; deferred: number }> {
  const snapshot = await adapter.fetchSource(config.sourceRef, ctx);
  if (snapshot.entries.every((entry) => entry.meta)) {
    return {
      data: {
        metas: snapshot.entries.flatMap((entry) =>
          entry.meta ? [withLinkBack(entry.meta, entry, config.provider)] : [],
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
    metas.push(withLinkBack(meta, entry, config.provider));
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

/** Why a read failed, in the words of the catalog card and the configure page. */
function problemReason(error: unknown): SourceProblemReason {
  // An expired Connection is an expected state (the user revoked access):
  // the catalog asks to connect again instead of a 500 that Stremio retries.
  return error instanceof SourceUnavailableError
    ? error.reason
    : error instanceof ConnectionExpiredError
      ? "needs_connection"
      : "unavailable";
}

async function fetchAndCacheList(
  config: ListFetchConfig,
  superseded: () => boolean,
): Promise<FreshList> {
  const adapter = getProvider(config.provider);
  let ctx: ProviderContext | null = null;
  let built: { data: CatalogData; deferred: number };
  try {
    if (!isProviderEnabled(config.provider)) {
      throw new SourceUnavailableError(
        "disabled",
        `${config.provider} is turned off`,
      );
    }
    ctx = await providerContext(config);
    built = await buildCatalog(adapter, config, ctx);
  } catch (error) {
    if (!superseded()) {
      await recordRefreshOutcome(
        config,
        { problem: problemReason(error) },
        ctx?.connection ?? null,
      );
    }
    throw error;
  }
  const { data, deferred } = built;
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
  if (superseded()) return { data, cachedAt, generation: null };
  let generation: string | null = null;
  try {
    generation = await writeCachedList(config.listId, data, storedAt);
  } catch (error) {
    // Later requests still get the old Catalog, so this is no "Updated";
    // the Provider did accept the Connection, though.
    console.error(`Failed to cache list ${config.listId} in R2:`, error);
    await reportConnectionWorking(config, ctx.connection);
    return { data, cachedAt, generation };
  }
  if (!superseded()) {
    await recordRefreshOutcome(
      config,
      { titleCount: data.metas.length },
      ctx.connection,
    );
  }
  return { data, cachedAt, generation };
}

function refreshList(config: ListFetchConfig): Promise<FreshList> {
  // One read per List and per access level at a time: a save can prewarm at
  // the same moment Stremio requests the Catalog.
  const key = `${config.listId}:${config.allowConnection ? "c" : "p"}`;
  const existing = inFlightRefreshes.get(key);
  if (existing && !config.freshRead) return existing.promise;
  // The older read may use an older Connection: its late result must not
  // replace the Catalog or the status of this one.
  if (existing) existing.state.superseded = true;

  const state = { superseded: false };
  const refresh: InFlightRefresh = {
    promise: fetchAndCacheList(config, () => state.superseded),
    state,
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

function toListError(
  source: { provider: ProviderId; sourceRef: string },
  error: unknown,
  message: string,
): ListUnavailableError {
  return new ListUnavailableError(source, problemReason(error), message);
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

    // A List that lost its Connection must not keep serving the private
    // items it cached while connected.
    const lostConnection =
      error instanceof ConnectionExpiredError ||
      (error instanceof SourceUnavailableError &&
        error.reason === "needs_connection");
    if (!config.noCacheFallback && !lostConnection) {
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
      config,
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

/**
 * After a disconnect: drop the cached Catalogs of the Account's Lists that
 * were read through that Connection, so nothing private stays served.
 */
export async function forgetConnectionLists(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const lists = await getAccountLists(accountId);
  await Promise.all(
    lists
      .filter(
        (list) =>
          list.provider === provider &&
          sourceRequiresConnection(list.provider, list.sourceRef),
      )
      .map((list) => deleteCachedList(list.id)),
  );
}
