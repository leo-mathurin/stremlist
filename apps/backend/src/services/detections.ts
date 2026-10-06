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
import type { AccountAccess } from "./accounts";
import { getAccountLists } from "./accounts";
import { buildPosterUrl } from "./imdb-scraper";
import { getCachedList } from "./list-cache";

/**
 * Detections (ADR 0004): Stremlist compares each complete, successful
 * synchronization of a Source list with the one before, and records when a
 * Title first appears. The first complete synchronization is the Baseline.
 */

interface SourceKey {
  provider: ProviderId;
  sourceRef: string;
}

/** One Title of the "New titles" catalog, with its first detection. */
interface Detection {
  imdbId: string;
  detectedAt: Date;
  /** The List whose Source list had the earliest detection. */
  list: ConfigList;
}

/**
 * Most detection rows read for one catalog request, newest first. Older
 * detections drop out of the catalog, which only shows what is new.
 */
const MAX_DETECTIONS = 1000;

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function sourceKey(source: SourceKey): string {
  return `${source.provider}\u0000${source.sourceRef}`;
}

/** Lists a request may see: Legacy alias requests only see public ones. */
function visibleLists(
  { via }: AccountAccess,
  lists: ConfigList[],
): ConfigList[] {
  return via === "private"
    ? lists
    : lists.filter(
        (list) => !sourceRequiresConnection(list.provider, list.sourceRef),
      );
}

/**
 * Record one complete, successful synchronization of a Source list. Callers
 * must not call this for a failed or incomplete read (a Provider error, a
 * page cap, an Unresolved entry): a missing Title would look like a removal.
 * Never throws, because a catalog must not fail on its history.
 */
export async function recordSynchronization(
  accountId: string,
  source: SourceKey & { listId: string },
  imdbIds: string[],
  syncedAt: Date,
): Promise<void> {
  const { data, error } = await supabase.rpc("record_source_list_sync", {
    p_account_id: accountId,
    p_provider: source.provider,
    p_source_ref: source.sourceRef,
    p_imdb_ids: imdbIds,
    p_synced_at: syncedAt.toISOString(),
  });
  if (error) {
    console.error(
      `Failed to record the synchronization of list ${source.listId}:`,
      error.message,
    );
    return;
  }
  if (data) {
    console.log(`List ${source.listId}: ${data} newly detected titles`);
  }
}

/**
 * Detected Titles that the Lists still contain, newest first, one per Title:
 * a Title that several Lists have keeps its earliest detection.
 */
async function loadDetections(
  accountId: string,
  lists: ConfigList[],
): Promise<Detection[]> {
  if (lists.length === 0) return [];
  const { data, error } = await supabase
    .from("title_detections")
    .select("provider, source_ref, imdb_id, detected_at")
    .eq("account_id", accountId)
    .in("source_ref", [...new Set(lists.map((list) => list.sourceRef))])
    .not("detected_at", "is", null)
    .is("removed_at", null)
    .order("detected_at", { ascending: false })
    .limit(MAX_DETECTIONS);
  if (error) throw error;

  const listsBySource = new Map(lists.map((list) => [sourceKey(list), list]));
  const earliest = new Map<string, Detection>();
  for (const row of data) {
    const list = listsBySource.get(
      sourceKey({
        provider: row.provider as ProviderId,
        sourceRef: row.source_ref,
      }),
    );
    if (!list || !row.detected_at) continue;
    const detectedAt = new Date(row.detected_at);
    const current = earliest.get(row.imdb_id);
    if (!current || detectedAt < current.detectedAt) {
      earliest.set(row.imdb_id, { imdbId: row.imdb_id, detectedAt, list });
    }
  }
  return [...earliest.values()].sort(
    (a, b) =>
      b.detectedAt.getTime() - a.detectedAt.getTime() ||
      a.imdbId.localeCompare(b.imdbId),
  );
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
  const lists = visibleLists(access, await getAccountLists(access.account.id));
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
  try {
    const [detections, syncs] = await Promise.all([
      loadDetections(access.account.id, lists),
      lists.length === 0
        ? Promise.resolve([])
        : supabase
            .from("source_list_syncs")
            .select("provider, source_ref")
            .eq("account_id", access.account.id)
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            }),
    ]);
    const synced = new Set(
      syncs.map((row) =>
        sourceKey({
          provider: row.provider as ProviderId,
          sourceRef: row.source_ref,
        }),
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

export async function setNewTitlesCatalog(
  accountId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({ new_titles_catalog: enabled })
    .eq("id", accountId);
  if (error) throw error;
}

/**
 * After a disconnect: forget the history of the Source lists that only that
 * Connection could read, so nothing private stays stored. The history of
 * public Source lists stays.
 */
export async function forgetConnectionDetections(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const { data, error } = await supabase
    .from("source_list_syncs")
    .select("source_ref")
    .eq("account_id", accountId)
    .eq("provider", provider);
  if (error) throw error;
  const refs = data
    .map((row) => row.source_ref)
    .filter((ref) => sourceRequiresConnection(provider, ref));
  if (refs.length === 0) return;
  // One delete: the detections go with their row (ON DELETE CASCADE), so a
  // history is never left without its Baseline.
  const { error: deleteError } = await supabase
    .from("source_list_syncs")
    .delete()
    .eq("account_id", accountId)
    .eq("provider", provider)
    .in("source_ref", refs);
  if (deleteError) throw deleteError;
}
