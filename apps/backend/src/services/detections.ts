import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import { storedSourceNoun } from "@stremlist/shared/source-problems";
import type {
  ConfigList,
  NewTitlesSummary,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { supabase } from "../lib/supabase";
import type { ProviderAdapter, SourceEntry } from "../providers/types";
import type { AccountAccess } from "./accounts";
import { getVisibleLists, visibleLists } from "./accounts";
import { buildPosterUrl } from "./imdb-scraper";
import { getCachedList } from "./list-cache";

/** One Title of the "New titles" catalog, with its first detection. */
interface Detection {
  imdbId: string;
  detectedAt: Date;
  /** The List whose Source list had the earliest detection. */
  list: ConfigList;
}

/**
 * Most Titles read for one catalog request, newest first. Older detections
 * drop out of the catalog, which only shows what is new.
 */
const MAX_DETECTIONS = 1000;

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** One Source list, as a Map key. Rows from the database have plain strings. */
function sourceKey(source: { provider: string; sourceRef: string }): string {
  return `${source.provider}\u0000${source.sourceRef}`;
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The stable identity of an entry in its Source list, resolved or not: the
 * Provider's own ID (the resolver key), else the IMDb ID, else a normalized
 * title and year for Providers that give no ID for the entry. Null when the
 * entry has none of these: it cannot be followed between synchronizations.
 */
export function entryKey(
  adapter: ProviderAdapter,
  entry: SourceEntry,
): string | null {
  const key = adapter.resolutionKey?.(entry);
  if (key) return `${key.namespace}:${key.externalId}`;
  if (entry.imdbId) return `imdb:${entry.imdbId}`;
  const title = entry.title ? normalizeTitle(entry.title) : "";
  return title ? `title:${title}:${entry.year ?? ""}` : null;
}

/**
 * Record one complete, successful synchronization of a Source list: no
 * Provider error and every page read. Unresolved entries (without an IMDb ID
 * in `imdbIds`) count by their entry key. Callers must not call this for a
 * failed or cut-short read: a missing entry would look like a removal. Never
 * throws, because a catalog must not fail on its history.
 */
export async function recordSynchronization(
  source: {
    accountId: string;
    listId: string;
    provider: ProviderId;
    sourceRef: string;
  },
  adapter: ProviderAdapter,
  entries: SourceEntry[],
  imdbIds: ReadonlyMap<SourceEntry, string>,
  read: {
    /** When the read started: a slower, older read never wins. */
    startedAt: Date;
    /** The Connection user the read went through, if any. */
    connectionUser: string | null;
  },
): Promise<void> {
  const keyed = entries.flatMap((entry) => {
    const key = entryKey(adapter, entry);
    return key ? [{ key, imdbId: imdbIds.get(entry) ?? null }] : [];
  });
  // History of a Source list that only a Connection can read belongs to
  // that Connection's Provider user. The database refuses the write when
  // that Connection is gone or replaced (a disconnect during the read).
  const requiresConnection = sourceRequiresConnection(
    source.provider,
    source.sourceRef,
  );
  const { data, error } = await supabase.rpc("record_source_list_sync", {
    p_account_id: source.accountId,
    p_provider: source.provider,
    p_source_ref: source.sourceRef,
    p_entry_keys: keyed.map((entry) => entry.key),
    p_imdb_ids: keyed.map((entry) => entry.imdbId),
    p_synced_at: read.startedAt.toISOString(),
    p_requires_connection: requiresConnection,
    p_connection_user: requiresConnection ? read.connectionUser : null,
  });
  if (error) {
    console.error(
      `Failed to record the synchronization of list ${source.listId}:`,
      error.message,
    );
    return;
  }
  if (data) {
    console.log(`List ${source.listId}: ${data} new entries`);
  }
}

/**
 * Detected Titles that the Lists still contain, newest first, one per Title:
 * a Title that several Lists have keeps its earliest detection. The rules
 * live in public.list_new_titles.
 */
async function loadDetections(
  accountId: string,
  lists: ConfigList[],
): Promise<Detection[]> {
  if (lists.length === 0) return [];
  const { data, error } = await supabase.rpc("list_new_titles", {
    p_account_id: accountId,
    p_providers: lists.map((list) => list.provider),
    p_source_refs: lists.map((list) => list.sourceRef),
    p_limit: MAX_DETECTIONS,
  });
  if (error) throw error;

  const listsBySource = new Map(lists.map((list) => [sourceKey(list), list]));
  return data.flatMap((row) => {
    const list = listsBySource.get(
      sourceKey({ provider: row.provider, sourceRef: row.source_ref }),
    );
    return list
      ? [{ imdbId: row.imdb_id, detectedAt: new Date(row.detected_at), list }]
      : [];
  });
}

/** The List's name as the user sees it, for the detection line. */
function listName(list: ConfigList): string {
  const title = list.catalogTitle.trim();
  // Default titles are positions ("1", "2"), which say nothing on their own.
  if (title && !/^\d+$/u.test(title)) return title;
  return `your ${PROVIDERS[list.provider].label} ${storedSourceNoun(list.provider, list.sourceRef)}`;
}

function withDetectionLine(
  meta: StremioMeta,
  detection: Detection,
): StremioMeta {
  const line = `Detected by Stremlist on ${DATE_FORMAT.format(detection.detectedAt)} in ${listName(detection.list)}.`;
  return {
    ...meta,
    description: meta.description ? `${line}\n\n${meta.description}` : line,
  };
}

/**
 * The "New titles" catalog of an Account: Titles detected in its Lists,
 * newest detection first, without duplicates. Reads only the cached Catalogs
 * for metadata, never a Provider, like the meta route: a Title whose List has
 * no cached Catalog yet waits for the next request.
 */
export async function getNewTitlesCatalog(
  access: AccountAccess,
  type: "movie" | "series",
): Promise<StremioMeta[]> {
  const lists = await getVisibleLists(access);
  const detections = await loadDetections(access.account.id, lists);
  if (detections.length === 0) return [];

  const cached = await Promise.all(
    lists.map(async (list) => {
      const catalog = await getCachedList(list.id);
      return [
        list.id,
        new Map(catalog?.data.metas.map((meta) => [meta.id, meta]) ?? []),
      ] as const;
    }),
  );
  const metasByList = new Map(cached);

  return detections.flatMap((detection) => {
    // Prefer the List that detected the Title: its metadata carries the
    // link back to that Provider.
    const meta =
      metasByList.get(detection.list.id)?.get(detection.imdbId) ??
      [...metasByList.values()]
        .map((metas) => metas.get(detection.imdbId))
        .find((found) => !!found);
    if (meta?.type !== type) return [];
    return [
      {
        ...withDetectionLine(meta, detection),
        poster: buildPosterUrl(meta.id, meta.poster, access.account.rpdbApiKey),
      },
    ];
  });
}

/**
 * What the configure page says about the "New titles" catalog. Null when the
 * history cannot be read: the page then shows only the setting.
 */
export async function getNewTitlesSummary(
  access: AccountAccess,
  allLists: ConfigList[],
): Promise<NewTitlesSummary | null> {
  const lists = visibleLists(access, allLists);
  if (lists.length === 0) {
    return { detected: 0, latestDetectedAt: null, waitingLists: 0 };
  }
  try {
    const [detections, { data: syncs, error }] = await Promise.all([
      loadDetections(access.account.id, lists),
      supabase
        .from("source_list_syncs")
        .select("provider, source_ref")
        .eq("account_id", access.account.id),
    ]);
    if (error) throw error;
    const synced = new Set(
      syncs.map((row) =>
        sourceKey({ provider: row.provider, sourceRef: row.source_ref }),
      ),
    );
    return {
      detected: detections.length,
      latestDetectedAt: detections[0]?.detectedAt.toISOString() ?? null,
      waitingLists: lists.filter((list) => !synced.has(sourceKey(list))).length,
    };
  } catch (error) {
    console.error(
      "Failed to read the detection history:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * After a disconnect or a new Connection: forget the history of the Source
 * lists that only a previous Provider user's Connection could read (see
 * public.forget_connection_history).
 */
export async function forgetConnectionDetections(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const { error } = await supabase.rpc("forget_connection_history", {
    p_account_id: accountId,
    p_provider: provider,
  });
  if (error) throw error;
}
