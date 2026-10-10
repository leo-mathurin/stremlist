/**
 * In-memory versions of the RPCs in supabase/migrations that record what a
 * read of a Source list found: List sync status and New titles detection.
 */
import type { RpcArgs, RpcHandler } from "./rpc";
import type { Result, Row } from "./store";
import { db, now } from "./store";

/** Same rules as public.record_source_list_sync. */
function recordSourceListSync(args: RpcArgs): Result {
  const key = {
    account_id: args.p_account_id,
    provider: args.p_provider,
    source_ref: args.p_source_ref,
  };
  const matches = (row: Row) =>
    row.account_id === key.account_id &&
    row.provider === key.provider &&
    row.source_ref === key.source_ref;
  const keys = args.p_entry_keys as string[];
  const imdbIds = args.p_imdb_ids as (string | null)[];
  // One pair per entry key; a resolved duplicate wins over an unresolved one.
  const entries = new Map<string, string | null>();
  keys.forEach((entryKey, index) => {
    entries.set(entryKey, entries.get(entryKey) ?? imdbIds[index]);
  });
  const syncedAt = new Date(args.p_synced_at as string).toISOString();
  const connectionUser = args.p_requires_connection
    ? ((args.p_connection_user as string | null | undefined) ?? null)
    : null;
  if (args.p_requires_connection) {
    const connected = db
      .getTable("connections")
      .some(
        (row) =>
          row.account_id === key.account_id &&
          row.provider === key.provider &&
          (row.provider_username ?? null) === connectionUser,
      );
    if (!connected) return { data: null, error: null };
    // Another Provider user: the old history is not theirs.
    db.delete(
      "source_list_syncs",
      (row) => matches(row) && row.connection_user !== connectionUser,
    );
  }
  const state = db.getTable("source_list_syncs").find(matches);

  if (!state) {
    db.insert("source_list_syncs", {
      ...key,
      baseline_at: syncedAt,
      last_complete_sync_at: syncedAt,
      requires_connection: !!args.p_requires_connection,
      connection_user: connectionUser,
    });
    for (const [entryKey, imdbId] of entries) {
      db.insert("source_list_entries", {
        ...key,
        entry_key: entryKey,
        imdb_id: imdbId,
      });
    }
    return { data: 0, error: null };
  }
  if (syncedAt <= String(state.last_complete_sync_at)) {
    return { data: null, error: null };
  }

  const rows = db.getTable("source_list_entries").filter(matches);
  for (const row of rows) {
    const entryKey = row.entry_key as string;
    if (!entries.has(entryKey)) {
      row.removed_at ??= syncedAt;
      continue;
    }
    row.removed_at = null;
    row.imdb_id = entries.get(entryKey) ?? row.imdb_id;
  }
  const known = new Set(rows.map((row) => row.entry_key));
  let added = 0;
  for (const [entryKey, imdbId] of entries) {
    if (known.has(entryKey)) continue;
    db.insert("source_list_entries", {
      ...key,
      entry_key: entryKey,
      imdb_id: imdbId,
      detected_at: syncedAt,
    });
    added += 1;
  }
  state.last_complete_sync_at = syncedAt;
  return { data: added, error: null };
}

/** Same rules as public.list_new_titles. */
function listNewTitles(args: RpcArgs): Result {
  const providers = args.p_providers as string[];
  const refs = args.p_source_refs as string[];
  const sources = new Set(
    providers.map((provider, index) => `${provider}\u0000${refs[index]}`),
  );
  const perSource = new Map<
    string,
    {
      imdb_id: string;
      provider: string;
      source_ref: string;
      detected_at: string | null;
      inBaseline: boolean;
      present: boolean;
    }
  >();
  for (const row of db.getTable("source_list_entries")) {
    const source = `${String(row.provider)}\u0000${String(row.source_ref)}`;
    if (
      row.account_id !== args.p_account_id ||
      !row.imdb_id ||
      !sources.has(source)
    ) {
      continue;
    }
    const imdbId = row.imdb_id as string;
    const groupKey = `${source}\u0000${imdbId}`;
    const group = perSource.get(groupKey) ?? {
      imdb_id: imdbId,
      provider: row.provider as string,
      source_ref: row.source_ref as string,
      detected_at: null,
      inBaseline: false,
      present: false,
    };
    const detectedAt = row.detected_at as string | null;
    if (!detectedAt) group.inBaseline = true;
    else if (!group.detected_at || detectedAt < group.detected_at) {
      group.detected_at = detectedAt;
    }
    if (!row.removed_at) group.present = true;
    perSource.set(groupKey, group);
  }
  // Earliest Detection among the Source lists where the Title is new, also
  // removed ones; shown while one of them still has it.
  const candidates = [...perSource.values()].filter(
    (group) => !group.inBaseline,
  );
  const shown = new Set(
    candidates.filter((group) => group.present).map((group) => group.imdb_id),
  );
  const earliest = new Map<string, (typeof candidates)[number]>();
  for (const group of candidates) {
    const current = earliest.get(group.imdb_id);
    if (
      shown.has(group.imdb_id) &&
      (!current || String(group.detected_at) < String(current.detected_at))
    ) {
      earliest.set(group.imdb_id, group);
    }
  }
  const rows = [...earliest.values()].sort(
    (a, b) =>
      String(b.detected_at).localeCompare(String(a.detected_at)) ||
      a.imdb_id.localeCompare(b.imdb_id),
  );
  return { data: rows.slice(0, args.p_limit as number), error: null };
}

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
  record_source_list_sync: recordSourceListSync,
  list_new_titles: listNewTitles,
};
