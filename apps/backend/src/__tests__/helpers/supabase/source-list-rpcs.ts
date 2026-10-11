/**
 * In-memory versions of the RPCs in supabase/migrations that record what a
 * read of a Source list found: List sync status.
 */
import type { RpcArgs, RpcHandler } from "./rpc";
import type { Result, Row } from "./store";
import { db, now } from "./store";

/** Same rules as public.record_list_refresh. */
function recordListRefresh(args: RpcArgs): Result {
  if (!db.getTable("lists").some((row) => row.id === args.p_list_id)) {
    return { data: false, error: null };
  }
  const at = now();
  const failed = args.p_failure_reason != null;
  const existing = db
    .getTable("list_sync_status")
    .find(
      (row) =>
        row.list_id === args.p_list_id &&
        row.provider === args.p_provider &&
        row.source_ref === args.p_source_ref,
    );
  const next: Row = {
    list_id: args.p_list_id,
    provider: args.p_provider,
    source_ref: args.p_source_ref,
    last_attempt_at: at,
    last_success_at: failed ? (existing?.last_success_at ?? null) : at,
    title_count: failed
      ? (existing?.title_count ?? null)
      : (args.p_title_count ?? null),
    failure_reason: args.p_failure_reason ?? null,
    failing_since: failed ? (existing?.failing_since ?? at) : null,
  };
  if (existing) Object.assign(existing, next);
  else db.insert("list_sync_status", next);
  return { data: true, error: null };
}

export const sourceListRpcs: Partial<Record<string, RpcHandler>> = {
  record_list_refresh: recordListRefresh,
};
