/**
 * The in-memory tables behind the Supabase mock: column defaults, unique
 * constraints and ON DELETE CASCADE from supabase/migrations.
 */

export type Row = Record<string, unknown>;
export interface Result {
  data: unknown;
  error: unknown;
  count?: number;
}

export const EPOCH = "1970-01-01T00:00:00.000Z";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Same shape as public.generate_account_id(). */
export function generateAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return `sl_${Array.from(bytes, (byte) => BASE62[byte % 62]).join("")}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Column defaults from the migrations, per table. */
const TABLE_DEFAULTS: Partial<Record<string, () => Row>> = {
  accounts: () => ({
    id: generateAccountId(),
    is_active: true,
    created_at: now(),
    last_fetched_at: now(),
    last_cache_served_at: null,
    legacy_imdb_user_id: null,
    moved_at: null,
    rpdb_api_key: null,
    actions_enabled: false,
    action_providers: [],
    new_titles_catalog: false,
    prewarm_lease_token: null,
    prewarm_locked_until: EPOCH,
    prewarm_request_generation: 0,
  }),
  lists: () => ({
    id: crypto.randomUUID(),
    catalog_title: "",
    catalog_settings: {},
    merged_sources: [],
    source_label: null,
    display_mode: "split",
    position: 0,
    sort_option: "added_at-asc",
    created_at: now(),
    updated_at: now(),
  }),
  connections: () => ({
    provider_username: null,
    refresh_token: null,
    expires_at: null,
    scope: null,
    refresh_locked_until: EPOCH,
    refresh_lease_token: null,
    needs_renewal_since: null,
    created_at: now(),
    updated_at: now(),
  }),
  list_sync_status: () => ({
    last_success_at: null,
    title_count: null,
    failure_reason: null,
    failing_since: null,
  }),
  oauth_states: () => ({ created_at: now() }),
  title_id_map: () => ({
    imdb_id: null,
    strategy: null,
    resolved_at: now(),
    retry_after: null,
  }),
  source_list_syncs: () => ({
    requires_connection: false,
    connection_user: null,
  }),
  source_list_entries: () => ({
    imdb_id: null,
    detected_at: null,
    removed_at: null,
  }),
};

export const UNIQUE_KEYS: Partial<Record<string, string[][]>> = {
  accounts: [["id"], ["legacy_imdb_user_id"]],
  lists: [["id"], ["account_id", "provider", "source_ref"]],
  connections: [["account_id", "provider"]],
  list_sync_status: [["list_id", "provider", "source_ref"]],
  oauth_states: [["state"]],
  title_id_map: [["namespace", "external_id"]],
  source_list_syncs: [["account_id", "provider", "source_ref"]],
  source_list_entries: [["account_id", "provider", "source_ref", "entry_key"]],
};

/** Foreign keys with ON DELETE CASCADE, as child table and shared columns. */
const CASCADES: Partial<Record<string, { table: string; columns: string[] }>> =
  {
    source_list_syncs: {
      table: "source_list_entries",
      columns: ["account_id", "provider", "source_ref"],
    },
  };

export function withoutUndefined(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  );
}

export class InMemoryDB {
  tables: Record<string, Row[]> = {};

  getTable(name: string): Row[] {
    this.tables[name] ??= [];
    return this.tables[name];
  }

  reset() {
    this.tables = {};
  }

  seed(table: string, rows: Row[]) {
    this.tables[table] = rows.map((r) => this.withDefaults(table, r));
  }

  withDefaults(table: string, row: Row): Row {
    const defaults = TABLE_DEFAULTS[table]?.() ?? {
      id: crypto.randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    return { ...defaults, ...withoutUndefined(row) };
  }

  /** Insert one row with the table's defaults, as Postgres would. */
  insert(table: string, row: Row): Row {
    const stored = this.withDefaults(table, row);
    const conflict = this.uniqueViolation(table, stored);
    if (conflict) throw new Error(conflict);
    this.getTable(table).push(stored);
    return stored;
  }

  /** Delete the matching rows, and their children (ON DELETE CASCADE). */
  delete(table: string, matches: (row: Row) => boolean): Row[] {
    const removed = this.getTable(table).filter(matches);
    this.tables[table] = this.getTable(table).filter((row) => !matches(row));
    const cascade = CASCADES[table];
    if (cascade && removed.length > 0) {
      this.delete(cascade.table, (child) =>
        removed.some((parent) =>
          cascade.columns.every((column) => parent[column] === child[column]),
        ),
      );
    }
    return removed;
  }

  /** The violated constraint, or null. `ignore` is the row being updated. */
  uniqueViolation(table: string, row: Row, ignore?: Row): string | null {
    for (const columns of UNIQUE_KEYS[table] ?? []) {
      if (columns.some((column) => row[column] == null)) continue;
      const clash = this.getTable(table).some(
        (existing) =>
          existing !== ignore &&
          columns.every((column) => existing[column] === row[column]),
      );
      if (clash) return `${table} (${columns.join(", ")})`;
    }
    return null;
  }
}

export function uniqueError(constraint: string) {
  return {
    message: `duplicate key value violates unique constraint ${constraint}`,
    code: "23505",
  };
}

// Singleton used by both the mock and the tests
export const db = new InMemoryDB();
