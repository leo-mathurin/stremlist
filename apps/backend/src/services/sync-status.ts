import type { ProviderId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { SOURCE_PROBLEM_REASONS } from "@stremlist/shared/source-problems";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import type { ListSyncStatuses } from "@stremlist/shared/sync-status";
import { supabase } from "../lib/supabase";
import {
  clearConnectionRenewal,
  markConnectionNeedsRenewal,
} from "./connections";
import { getCachedListInfo } from "./list-cache";

export interface RefreshedSource {
  accountId: string;
  listId: string;
  provider: ProviderId;
  sourceRef: string;
}

export type RefreshOutcome =
  | { titleCount: number }
  | { problem: SourceProblemReason };

function isProblemReason(value: string): value is SourceProblemReason {
  return (SOURCE_PROBLEM_REASONS as readonly string[]).includes(value);
}

/**
 * Remember how a read of a List's Source list ended, for the configure page.
 * When the read went through a Connection, its outcome also tells whether the
 * Provider still accepts that Connection. Never throws: a status that could
 * not be written must not fail the Catalog.
 */
export async function recordRefreshOutcome(
  source: RefreshedSource,
  outcome: RefreshOutcome,
  readThroughConnection: boolean,
): Promise<void> {
  const problem = "problem" in outcome ? outcome.problem : null;
  const writes: Promise<void>[] = [
    (async () => {
      const { error } = await supabase.rpc("record_list_refresh", {
        p_list_id: source.listId,
        p_provider: source.provider,
        p_source_ref: source.sourceRef,
        p_failure_reason: problem,
        p_title_count: "titleCount" in outcome ? outcome.titleCount : null,
      });
      if (error) throw new Error(error.message);
    })(),
  ];
  // Only a private Source list proves that the Connection works: a public
  // one may have been read without it.
  if (
    readThroughConnection &&
    problem === null &&
    sourceRequiresConnection(source.provider, source.sourceRef)
  ) {
    writes.push(clearConnectionRenewal(source.accountId, source.provider));
  }
  if (readThroughConnection && problem === "needs_connection") {
    writes.push(markConnectionNeedsRenewal(source.accountId, source.provider));
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

interface StatusRow {
  list_id: string;
  provider: string;
  source_ref: string;
  last_attempt_at: string;
  last_success_at: string | null;
  title_count: number | null;
  failure_reason: string | null;
  failing_since: string | null;
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

  const statuses: ListSyncStatuses = {};
  const rows = error ? [] : (data as StatusRow[]);
  const recorded = new Set(rows.map((row) => row.list_id));
  for (const row of rows) {
    const list = lists.find((candidate) => candidate.id === row.list_id);
    if (list?.provider !== row.provider || list.sourceRef !== row.source_ref) {
      continue;
    }
    statuses[list.id] = {
      sourceRef: row.source_ref,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      titleCount: row.title_count,
      problem:
        row.failure_reason === null
          ? null
          : isProblemReason(row.failure_reason)
            ? row.failure_reason
            : "unavailable",
      failingSince: row.failing_since,
    };
  }
  // Lists cached before sync statuses existed: their cache tells when they
  // last refreshed. Not for a List that changed its Source list, whose cache
  // may still hold the old one.
  await Promise.all(
    lists
      .filter((list) => !recorded.has(list.id))
      .map(async (list) => {
        const info = await getCachedListInfo(list.id);
        if (!info) return;
        statuses[list.id] = {
          sourceRef: list.sourceRef,
          lastAttemptAt: info.cachedAt,
          lastSuccessAt: info.cachedAt,
          titleCount: info.titleCount,
          problem: null,
          failingSince: null,
        };
      }),
  );
  return statuses;
}
