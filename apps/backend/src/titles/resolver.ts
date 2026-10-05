import { supabase } from "../lib/supabase";
import type {
  ProviderAdapter,
  ResolutionKey,
  SourceEntry,
} from "../providers/types";

/** How long an entry that no strategy could resolve waits before a retry. */
const UNRESOLVED_RETRY_MS = 24 * 60 * 60_000;
/**
 * Most entries a single refresh sends through the strategies. A big cold list
 * resolves over a few refreshes instead of blocking one catalog request.
 */
const MAX_STRATEGY_ENTRIES_PER_REFRESH = 300;
const CACHE_QUERY_CHUNK = 200;

export interface ResolvedEntry {
  imdbId: string;
  entry: SourceEntry;
}

export interface ResolutionResult {
  /** Resolved entries, in Source list order. */
  resolved: ResolvedEntry[];
  /** Entries without an IMDb ID yet (Unresolved entries, see CONTEXT.md). */
  unresolved: number;
}

interface CacheRow {
  namespace: string;
  external_id: string;
  imdb_id: string | null;
  retry_after: string | null;
}

const IMDB_ID = /^tt\d+$/;

function cacheKey(key: ResolutionKey): string {
  return `${key.namespace}\u0000${key.externalId}`;
}

async function readCache(keys: ResolutionKey[]): Promise<Map<string, CacheRow>> {
  const rows = new Map<string, CacheRow>();
  const byNamespace = new Map<string, string[]>();
  for (const key of keys) {
    const ids = byNamespace.get(key.namespace) ?? [];
    ids.push(key.externalId);
    byNamespace.set(key.namespace, ids);
  }
  for (const [namespace, ids] of byNamespace) {
    for (let start = 0; start < ids.length; start += CACHE_QUERY_CHUNK) {
      const { data, error } = await supabase
        .from("title_id_map")
        .select("namespace, external_id, imdb_id, retry_after")
        .eq("namespace", namespace)
        .in("external_id", ids.slice(start, start + CACHE_QUERY_CHUNK));
      if (error) {
        console.error("Failed to read the title ID cache:", error.message);
        continue;
      }
      for (const row of data as CacheRow[]) {
        rows.set(
          cacheKey({ namespace: row.namespace, externalId: row.external_id }),
          row,
        );
      }
    }
  }
  return rows;
}

async function writeCache(
  rows: {
    key: ResolutionKey;
    imdbId: string | null;
    strategy: string | null;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const { error } = await supabase.from("title_id_map").upsert(
    rows.map(({ key, imdbId, strategy }) => ({
      namespace: key.namespace,
      external_id: key.externalId,
      imdb_id: imdbId,
      strategy,
      resolved_at: new Date(now).toISOString(),
      retry_after: imdbId
        ? null
        : new Date(now + UNRESOLVED_RETRY_MS).toISOString(),
    })),
    { onConflict: "namespace,external_id" },
  );
  if (error) {
    console.error("Failed to write the title ID cache:", error.message);
  }
}

/**
 * Give every entry of a Source list its IMDb ID (ADR 0002). Entries that
 * already carry one pass through. The others go through the resolver cache,
 * then through the adapter's strategies in order. Entries that stay
 * unresolved are retried on a later refresh, never dropped for good.
 */
export async function resolveEntries(
  adapter: ProviderAdapter,
  entries: SourceEntry[],
): Promise<ResolutionResult> {
  const imdbIds: (string | null)[] = entries.map((entry) =>
    entry.imdbId && IMDB_ID.test(entry.imdbId) ? entry.imdbId : null,
  );

  const pending: { index: number; key: ResolutionKey }[] = [];
  entries.forEach((entry, index) => {
    if (imdbIds[index]) return;
    const key = adapter.resolutionKey?.(entry);
    if (key) pending.push({ index, key });
  });

  if (pending.length > 0) {
    const cached = await readCache(pending.map(({ key }) => key));
    const now = Date.now();
    const toResolve: { index: number; key: ResolutionKey }[] = [];
    for (const item of pending) {
      const row = cached.get(cacheKey(item.key));
      if (row?.imdb_id) {
        imdbIds[item.index] = row.imdb_id;
      } else if (
        !row?.retry_after ||
        new Date(row.retry_after).getTime() <= now
      ) {
        toResolve.push(item);
      }
    }

    const batch = toResolve.slice(0, MAX_STRATEGY_ENTRIES_PER_REFRESH);
    const results = new Map<number, { imdbId: string; strategy: string }>();
    let remaining = batch;
    for (const strategy of adapter.resolverStrategies ?? []) {
      if (remaining.length === 0) break;
      try {
        const found = await strategy.resolve(
          remaining.map(({ index }) => entries[index]),
        );
        for (const [position, imdbId] of found) {
          const item = remaining[position];
          if (item && IMDB_ID.test(imdbId)) {
            results.set(item.index, { imdbId, strategy: strategy.name });
          }
        }
      } catch (error) {
        console.error(
          `ID resolver strategy ${strategy.name} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      remaining = remaining.filter(({ index }) => !results.has(index));
    }

    for (const [index, { imdbId }] of results) imdbIds[index] = imdbId;
    await writeCache(
      batch.map(({ index, key }) => ({
        key,
        imdbId: results.get(index)?.imdbId ?? null,
        strategy: results.get(index)?.strategy ?? null,
      })),
    );
  }

  const resolved: ResolvedEntry[] = [];
  entries.forEach((entry, index) => {
    const imdbId = imdbIds[index];
    if (imdbId) resolved.push({ imdbId, entry });
  });
  return { resolved, unresolved: entries.length - resolved.length };
}
