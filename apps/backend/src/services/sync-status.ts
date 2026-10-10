import type { Database } from "@stremlist/shared/database.types";
import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type {
  AccountSyncSnapshot,
  ConfigList,
} from "@stremlist/shared/stremio.types";
import type {
  ListSyncStatus,
  ListSyncStatuses,
} from "@stremlist/shared/sync-status";
import { supabase } from "../lib/supabase";
import type { ConnectionAccess } from "../providers/types";
import { getCachedListInfo } from "./list-cache";
import { sourceCaches } from "./merged-lists";

/** How one refresh of a List ended. */
export type RefreshOutcome =
  | { kind: "saved"; titleCount: number }
  /**
   * The read worked, but the Catalog could not be saved: Stremio still gets
   * the older one, so this is no update.
   */
  | { kind: "unsaved" }
  | { kind: "failed"; problem: SourceProblemReason };

type StatusRow = Database["public"]["Tables"]["list_sync_status"]["Row"];

/**
 * Remember how a refresh of a List's Source list ended, for the configure
 * page, and what it tells about the Connection it read through: a refused
 * read marks it for renewal, a working read of a private Source list clears
 * that mark (a public Source list may have been read without the
 * Connection). Never throws: a status that could not be written must not
 * fail the Catalog.
 */
export async function recordRefreshOutcome(
  source: SourceId & { listId: string },
  outcome: RefreshOutcome,
  connection: ConnectionAccess | null,
): Promise<void> {
  const problem = outcome.kind === "failed" ? outcome.problem : null;
  const writes: PromiseLike<void>[] = [];
  if (outcome.kind !== "unsaved") {
    writes.push(
      supabase
        .rpc("record_list_refresh", {
          p_list_id: source.listId,
          p_provider: source.provider,
          p_source_ref: source.sourceRef,
          p_failure_reason: problem,
          p_title_count: outcome.kind === "saved" ? outcome.titleCount : null,
        })
        .then(({ error }) => {
          if (error) throw new Error(error.message);
        }),
    );
  }
  if (connection && problem === "needs_connection") {
    writes.push(connection.reportRefused());
  }
  if (
    connection &&
    outcome.kind !== "failed" &&
    sourceRequiresConnection(source.provider, source.sourceRef)
  ) {
    writes.push(connection.reportWorking());
  }
  for (const result of await Promise.allSettled(writes)) {
    if (result.status === "rejected") {
      console.error(
        `Failed to record the refresh of list ${source.listId}:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }
}

function toStatus(row: StatusRow): ListSyncStatus {
  return {
    provider: row.provider as ProviderId,
    sourceRef: row.source_ref,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    titleCount: row.title_count,
    problem: row.failure_reason as SourceProblemReason | null,
    failingSince: row.failing_since,
  };
}

/**
 * Take the last success from the cache when no refresh recorded one: Lists
 * cached before sync statuses existed, also after their first recorded
 * refresh failed (Stremio still gets those cached Titles).
 */
async function withCachedSuccess(
  status: ListSyncStatus | null,
  source: ListSource,
  cacheKey: string,
): Promise<ListSyncStatus | null> {
  if (status?.lastSuccessAt) return status;
  const cached = await getCachedListInfo(cacheKey, source);
  if (!cached) return status;
  return {
    provider: source.provider,
    sourceRef: source.sourceRef,
    lastAttemptAt: cached.cachedAt,
    problem: null,
    failingSince: null,
    ...status,
    lastSuccessAt: cached.cachedAt,
    titleCount: cached.titleCount,
  };
}

/**
 * The sync status of each Source list of one List, from its recorded rows,
 * in the List's order; null for a Source list that was never read. In a
 * List with one Source list, a row for another Source list means the List
 * changed its Source list: its cache (under the List ID) may still hold the
 * old one, so it is not used. Each Source list of a merged List has a cache
 * of its own (ADR 0006).
 */
async function sourceStatusesOf(
  list: ConfigList,
  rows: StatusRow[],
): Promise<(ListSyncStatus | null)[]> {
  const caches = sourceCaches(list);
  return Promise.all(
    caches.map(async ({ source, cacheKey }) => {
      const row = rows.find(
        (candidate) =>
          candidate.provider === source.provider &&
          candidate.source_ref === source.sourceRef,
      );
      const status = row ? toStatus(row) : null;
      const changedSource =
        caches.length === 1 && rows.some((candidate) => candidate !== row);
      return changedSource
        ? status
        : await withCachedSuccess(status, source, cacheKey);
    }),
  );
}

/**
 * The sync status of each List, for the Source lists it reads now, in the
 * order of `listSources` (null for a Source list that was never read). When
 * the recorded statuses cannot be read, only the cache answers: the page
 * shows Lists as waiting, not as broken.
 */
export async function getListSyncStatuses(
  lists: ConfigList[],
): Promise<Pick<AccountSyncSnapshot, "syncStatus">> {
  if (lists.length === 0) return { syncStatus: {} };
  const { data, error } = await supabase
    .from("list_sync_status")
    .select("*")
    .in(
      "list_id",
      lists.map((list) => list.id),
    );
  if (error) {
    console.error("Failed to read list sync statuses:", error.message);
  }
  const statuses = await Promise.all(
    lists.map((list) =>
      sourceStatusesOf(
        list,
        (data ?? []).filter((row) => row.list_id === list.id),
      ),
    ),
  );
  const syncStatus: ListSyncStatuses = Object.fromEntries(
    lists.map((list, index) => [list.id, statuses[index]]),
  );
  return { syncStatus };
}
