import type { Database } from "@stremlist/shared/database.types";
import type { ProviderId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import type {
  ListSyncStatus,
  ListSyncStatuses,
} from "@stremlist/shared/sync-status";
import { supabase } from "../lib/supabase";
import type { ConnectionAccess } from "../providers/types";
import { getCachedListInfo } from "./list-cache";

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
  source: { listId: string; provider: ProviderId; sourceRef: string },
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

/**
 * Forget the statuses of Lists whose cached Catalogs were deleted (after a
 * disconnect): an old success must not say their Titles are still in Stremio.
 */
export async function forgetSyncStatuses(listIds: string[]): Promise<void> {
  if (listIds.length === 0) return;
  const { error } = await supabase
    .from("list_sync_status")
    .delete()
    .in("list_id", listIds);
  if (error) throw error;
}

/**
 * The sync status of one List from its recorded rows. Lists cached before
 * sync statuses existed take their last success from the cache, also after
 * their first recorded refresh failed (Stremio still gets those cached
 * Titles). A row for another Source list means the List changed its Source
 * list: its cache may still hold the old one, so it is not used.
 */
async function syncStatusOf(
  list: ConfigList,
  rows: StatusRow[],
): Promise<ListSyncStatus | null> {
  const row = rows.find(
    (candidate) =>
      candidate.provider === list.provider &&
      candidate.source_ref === list.sourceRef,
  );
  const status: ListSyncStatus | null = row
    ? {
        sourceRef: row.source_ref,
        lastAttemptAt: row.last_attempt_at,
        lastSuccessAt: row.last_success_at,
        titleCount: row.title_count,
        problem: row.failure_reason as SourceProblemReason | null,
        failingSince: row.failing_since,
      }
    : null;
  const changedSource = rows.some((candidate) => candidate !== row);
  if (changedSource || status?.lastSuccessAt) return status;

  const cached = await getCachedListInfo(list.id, list);
  if (!cached) return status;
  return {
    sourceRef: list.sourceRef,
    lastAttemptAt: cached.cachedAt,
    problem: null,
    failingSince: null,
    ...status,
    lastSuccessAt: cached.cachedAt,
    titleCount: cached.titleCount,
  };
}

/**
 * The sync status of each List, for the Source list it reads now. Lists that
 * were never read are left out. When the recorded statuses cannot be read,
 * only the cache answers: the page shows Lists as waiting, not as broken.
 */
export async function getListSyncStatuses(
  lists: ConfigList[],
): Promise<ListSyncStatuses> {
  if (lists.length === 0) return {};
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
      syncStatusOf(
        list,
        (data ?? []).filter((row) => row.list_id === list.id),
      ),
    ),
  );
  return Object.fromEntries(
    lists.flatMap((list, index) => {
      const status = statuses[index];
      return status ? [[list.id, status]] : [];
    }),
  );
}
