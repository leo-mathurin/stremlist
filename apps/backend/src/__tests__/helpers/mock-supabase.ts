/**
 * In-memory Supabase mock for E2E-style route tests.
 *
 * Supports the chained query patterns used throughout the backend
 * (select, insert, upsert, update, delete with eq/in/not/order/limit/single,
 * `.select()` after a write) and in-memory versions of the RPCs from
 * supabase/migrations, so routes can run end to end without a database.
 */

type Row = Record<string, unknown>;
interface Result {
  data: unknown;
  error: unknown;
  count?: number;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Same shape as public.generate_account_id(). */
export function generateAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return `sl_${Array.from(bytes, (byte) => BASE62[byte % 62]).join("")}`;
}

function now(): string {
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
    prewarm_lease_token: null,
    prewarm_locked_until: EPOCH,
    prewarm_request_generation: 0,
  }),
  lists: () => ({
    id: crypto.randomUUID(),
    catalog_title: "",
    catalog_settings: {},
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
};

/** Unique constraints from the migrations, per table. */
const UNIQUE_KEYS: Partial<Record<string, string[][]>> = {
  accounts: [["id"], ["legacy_imdb_user_id"]],
  lists: [["id"], ["account_id", "provider", "source_ref"]],
  connections: [["account_id", "provider"]],
  list_sync_status: [["list_id", "provider", "source_ref"]],
  oauth_states: [["state"]],
  title_id_map: [["namespace", "external_id"]],
};

function withoutUndefined(row: Row): Row {
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

function uniqueError(constraint: string) {
  return {
    message: `duplicate key value violates unique constraint ${constraint}`,
    code: "23505",
  };
}

class MockQueryBuilder {
  private db: InMemoryDB;
  private tableName: string;
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private filters: ((row: Row) => boolean)[] = [];
  private orderBys: [string, { ascending: boolean }][] = [];
  private limitN: number | null = null;
  private rangeFromTo: [number, number] | null = null;
  private isSingle = false;
  private isMaybeSingle = false;
  private selectCols: string | null = null;
  private wantReturn = false;
  private payload: unknown = null;
  private conflictCol: string | null = null;
  private countMode: string | null = null;
  private headOnly = false;

  constructor(db: InMemoryDB, table: string) {
    this.db = db;
    this.tableName = table;
  }

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.selectCols = cols ?? "*";
    } else {
      // `.select()` after a write returns the written rows.
      this.wantReturn = true;
      this.selectCols = cols ?? "*";
    }
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }

  insert(data: unknown) {
    this.op = "insert";
    this.payload = data;
    return this;
  }

  upsert(
    data: unknown,
    opts?: {
      onConflict?: string;
      ignoreDuplicates?: boolean;
    },
  ) {
    this.op = "upsert";
    this.payload = data;
    this.conflictCol = opts?.onConflict ?? "id";
    return this;
  }

  update(data: unknown) {
    this.op = "update";
    this.payload = data;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  neq(col: string, val: unknown) {
    this.filters.push((row) => row[col] !== val);
    return this;
  }

  is(col: string, val: null | boolean) {
    this.filters.push((row) => (row[col] ?? null) === val);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push((row) => vals.includes(row[col]));
    return this;
  }

  /** PostgREST `not`: supports the "is", "eq" and "in" operators. */
  not(col: string, operator: string, val: unknown) {
    this.filters.push((row) => {
      const value = row[col] ?? null;
      switch (operator) {
        case "is":
          return value !== val;
        case "eq":
          return value !== val;
        case "in": {
          const list = Array.isArray(val)
            ? val
            : String(val)
                .replace(/^\(|\)$/g, "")
                .split(",")
                .map((item) => item.trim().replace(/^"|"$/g, ""));
          return !list.includes(value);
        }
        default:
          throw new Error(`mock-supabase: unsupported not(${operator})`);
      }
    });
    return this;
  }

  // String comparison works for ISO timestamps (lexicographic == chrono).
  lt(col: string, val: unknown) {
    this.filters.push((row) => (row[col] as never) < (val as never));
    return this;
  }

  lte(col: string, val: unknown) {
    this.filters.push((row) => (row[col] as never) <= (val as never));
    return this;
  }

  gt(col: string, val: unknown) {
    this.filters.push((row) => (row[col] as never) > (val as never));
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push((row) => (row[col] as never) >= (val as never));
    return this;
  }

  order(col: string, opts?: { ascending: boolean }) {
    this.orderBys.push([col, opts ?? { ascending: true }]);
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number) {
    this.rangeFromTo = [from, to];
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  maybeSingle() {
    this.isSingle = true;
    this.isMaybeSingle = true;
    return this;
  }

  // ---- internals ----

  private matchesFilters(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private pickColumns(row: Row): Row {
    if (!this.selectCols || this.selectCols === "*") return { ...row };
    const cols = this.selectCols.split(",").map((c) => c.trim());
    const result: Row = {};
    for (const col of cols) {
      if (col in row) result[col] = row[col];
    }
    return result;
  }

  /** Shape the rows a query returns (`single`, `maybeSingle`, columns). */
  private respond(rows: Row[]): Result {
    const mapped = rows.map((r) => this.pickColumns(r));
    if (!this.isSingle) return { data: mapped, error: null };
    if (mapped.length === 0) {
      // maybeSingle resolves to null with no error; single errors.
      return {
        data: null,
        error: this.isMaybeSingle
          ? null
          : { message: "Row not found", code: "PGRST116" },
      };
    }
    if (mapped.length > 1) {
      return {
        data: null,
        error: { message: "Multiple rows returned", code: "PGRST116" },
      };
    }
    return { data: mapped[0], error: null };
  }

  private written(rows: Row[]): Result {
    return this.wantReturn ? this.respond(rows) : { data: null, error: null };
  }

  private execute(): Result {
    const table = this.db.getTable(this.tableName);

    switch (this.op) {
      case "select": {
        if (this.headOnly && this.countMode) {
          const count = table.filter((r) => this.matchesFilters(r)).length;
          return { data: null, error: null, count };
        }

        let rows = table.filter((r) => this.matchesFilters(r));

        if (this.orderBys.length > 0) {
          rows.sort((a, b) => {
            for (const [col, opts] of this.orderBys) {
              const av = a[col] as number;
              const bv = b[col] as number;
              const cmp = av < bv ? -1 : av > bv ? 1 : 0;
              if (cmp !== 0) return opts.ascending ? cmp : -cmp;
            }
            return 0;
          });
        }

        // PostgREST applies range (offset/limit window) after ordering.
        if (this.rangeFromTo !== null) {
          const [from, to] = this.rangeFromTo;
          rows = rows.slice(from, to + 1);
        }

        if (this.limitN !== null) rows = rows.slice(0, this.limitN);

        return this.respond(rows);
      }

      case "insert": {
        const items = (
          Array.isArray(this.payload) ? this.payload : [this.payload]
        ) as Row[];
        const rows = items.map((item) =>
          this.db.withDefaults(this.tableName, item),
        );
        for (const [index, row] of rows.entries()) {
          const conflict =
            this.db.uniqueViolation(this.tableName, row) ??
            (rows
              .slice(0, index)
              .some((earlier) =>
                (UNIQUE_KEYS[this.tableName] ?? []).some((columns) =>
                  columns.every(
                    (column) =>
                      row[column] != null && earlier[column] === row[column],
                  ),
                ),
              )
              ? this.tableName
              : null);
          if (conflict) return { data: null, error: uniqueError(conflict) };
        }
        table.push(...rows);
        return this.written(rows.map((row) => ({ ...row })));
      }

      case "upsert": {
        const items = (
          Array.isArray(this.payload) ? this.payload : [this.payload]
        ) as Row[];
        // onConflict may be a composite key ("namespace,external_id"): match
        // on every part, otherwise a composite upsert always collides with
        // the first row.
        const cols = (this.conflictCol ?? "id").split(",").map((c) => c.trim());

        // Postgres rejects an ON CONFLICT command that would touch the same row
        // twice (duplicate conflict keys within one batch). Mirror that so
        // callers that forget to de-duplicate a batch fail like in production.
        const batchKeys = new Set<string>();
        for (const item of items) {
          const key = cols.map((c) => String(item[c])).join("\u0000");
          if (batchKeys.has(key)) {
            return {
              data: null,
              error: {
                message:
                  "ON CONFLICT DO UPDATE command cannot affect row a second time",
                code: "21000",
              },
            };
          }
          batchKeys.add(key);
        }

        const results: Row[] = [];
        for (const record of items) {
          const idx = table.findIndex((r) =>
            cols.every((col) => r[col] === record[col]),
          );
          if (idx >= 0) {
            const next = { ...table[idx], ...withoutUndefined(record) };
            const conflict = this.db.uniqueViolation(
              this.tableName,
              next,
              table[idx],
            );
            if (conflict) return { data: null, error: uniqueError(conflict) };
            table[idx] = next;
            results.push({ ...next });
          } else {
            const row = this.db.withDefaults(this.tableName, record);
            const conflict = this.db.uniqueViolation(this.tableName, row);
            if (conflict) return { data: null, error: uniqueError(conflict) };
            table.push(row);
            results.push({ ...row });
          }
        }
        return this.written(results);
      }

      case "update": {
        const updated: Row[] = [];
        for (let i = 0; i < table.length; i++) {
          if (this.matchesFilters(table[i])) {
            table[i] = {
              ...table[i],
              ...withoutUndefined(this.payload as Row),
            };
            updated.push({ ...table[i] });
          }
        }
        return this.written(updated);
      }

      case "delete": {
        const removed = table.filter((r) => this.matchesFilters(r));
        this.db.tables[this.tableName] = table.filter(
          (r) => !this.matchesFilters(r),
        );
        return this.written(removed);
      }
    }
  }

  then(
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ) {
    try {
      const result = this.execute();
      return Promise.resolve(onfulfilled ? onfulfilled(result) : result);
    } catch (e) {
      if (onrejected) return Promise.resolve(onrejected(e));
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

// Singleton used by both the mock and the tests
export const db = new InMemoryDB();

// ---------------------------------------------------------------------------
// RPCs: in-memory versions of the SQL functions in supabase/migrations.
// ---------------------------------------------------------------------------

type RpcArgs = Record<string, unknown>;
export type RpcHandler = (args: RpcArgs) => Result | Promise<Result>;

function rpcError(message: string): Result {
  return { data: null, error: { message } };
}

function secondsFromNow(seconds: number, min: number, max: number): string {
  const clamped = Math.min(Math.max(seconds, min), max);
  return new Date(Date.now() + clamped * 1000).toISOString();
}

function replaceAccountConfig(args: RpcArgs): Result {
  const accountId = args.p_account_id as string;
  const account = db.getTable("accounts").find((row) => row.id === accountId);
  if (!account) return rpcError("Account not found");
  if (!Array.isArray(args.p_lists)) return rpcError("Lists must be an array");
  const items = args.p_lists as Row[];

  const ids = items.flatMap((item) =>
    typeof item.id === "string" ? [item.id] : [],
  );
  const lists = db.getTable("lists");
  if (
    ids.some(
      (id) =>
        !lists.some((row) => row.id === id && row.account_id === accountId),
    )
  ) {
    return rpcError("List does not belong to this account");
  }
  if (new Set(ids).size !== ids.length) return rpcError("Duplicate list ID");

  const deleted = lists.filter(
    (row) => row.account_id === accountId && !ids.includes(row.id as string),
  );
  db.tables.lists = lists.filter((row) => !deleted.includes(row));

  for (const item of items) {
    const fields: Row = {
      provider: item.provider,
      source_ref: item.source_ref,
      catalog_title: item.catalog_title,
      sort_option: item.sort_option,
      display_mode: item.display_mode,
      position: item.position,
    };
    const existing = db
      .getTable("lists")
      .find((row) => row.id === item.id && row.account_id === accountId);
    if (existing) {
      const next = {
        ...existing,
        ...fields,
        ...("catalog_settings" in item
          ? { catalog_settings: item.catalog_settings }
          : {}),
        updated_at: now(),
      };
      const conflict = db.uniqueViolation("lists", next, existing);
      if (conflict) return { data: null, error: uniqueError(conflict) };
      Object.assign(existing, next);
    } else {
      try {
        db.insert("lists", {
          ...fields,
          id: item.id,
          account_id: accountId,
          catalog_settings: item.catalog_settings ?? {},
        });
      } catch (error) {
        return { data: null, error: uniqueError(String(error)) };
      }
    }
  }

  account.rpdb_api_key = args.p_rpdb_api_key ?? null;
  account.actions_enabled = args.p_actions_enabled ?? account.actions_enabled;
  account.action_providers =
    args.p_action_providers ?? account.action_providers;

  const saved = db
    .getTable("lists")
    .filter((row) => row.account_id === accountId)
    .sort(
      (a, b) =>
        (a.position as number) - (b.position as number) ||
        String(a.created_at).localeCompare(String(b.created_at)),
    )
    .map((row) => ({ ...row }));
  return {
    data: [{ deleted_ids: deleted.map((row) => row.id), lists: saved }],
    error: null,
  };
}

function findConnection(args: RpcArgs): Row | undefined {
  return db
    .getTable("connections")
    .find(
      (row) =>
        row.account_id === args.p_account_id &&
        row.provider === args.p_provider,
    );
}

function findAccount(args: RpcArgs): Row | undefined {
  return db.getTable("accounts").find((row) => row.id === args.p_account_id);
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

export const defaultRpcHandlers: Partial<Record<string, RpcHandler>> = {
  replace_account_config: replaceAccountConfig,
  record_list_refresh: recordListRefresh,

  claim_connection_refresh(args) {
    const row = findConnection(args);
    if (!row || String(row.refresh_locked_until) > now()) {
      return { data: false, error: null };
    }
    row.refresh_locked_until = secondsFromNow(
      args.p_lease_seconds as number,
      1,
      300,
    );
    row.refresh_lease_token = args.p_lease_token;
    return { data: true, error: null };
  },

  release_connection_refresh(args) {
    const row = findConnection(args);
    if (!row || row.refresh_lease_token !== args.p_lease_token) {
      return { data: false, error: null };
    }
    row.refresh_locked_until = EPOCH;
    row.refresh_lease_token = null;
    return { data: true, error: null };
  },

  request_list_prewarm(args) {
    const row = findAccount(args);
    if (!row) return { data: null, error: null };
    row.prewarm_request_generation =
      (row.prewarm_request_generation as number) + 1;
    if (String(row.prewarm_locked_until) <= now()) {
      row.prewarm_lease_token = args.p_lease_token;
      row.prewarm_locked_until = secondsFromNow(
        args.p_lease_seconds as number,
        1,
        3600,
      );
    }
    return {
      data:
        row.prewarm_lease_token === args.p_lease_token
          ? row.prewarm_request_generation
          : null,
      error: null,
    };
  },

  finish_list_prewarm(args) {
    const row = findAccount(args);
    if (!row || row.prewarm_lease_token !== args.p_lease_token) {
      return { data: null, error: null };
    }
    const pending =
      (row.prewarm_request_generation as number) >
      (args.p_completed_generation as number);
    row.prewarm_locked_until = pending
      ? secondsFromNow(args.p_lease_seconds as number, 1, 3600)
      : EPOCH;
    if (!pending) row.prewarm_lease_token = null;
    return {
      data: pending ? row.prewarm_request_generation : null,
      error: null,
    };
  },
};

/** Per-test overrides; cleared by `resetRpc()`. */
export const rpcHandlers = new Map<string, RpcHandler>();

export function resetRpc(): void {
  rpcHandlers.clear();
}

export function callRpc(name: string, args: RpcArgs = {}): Promise<Result> {
  const handler = rpcHandlers.get(name) ?? defaultRpcHandlers[name];
  if (!handler) {
    return Promise.resolve(rpcError(`mock-supabase: unknown RPC ${name}`));
  }
  return Promise.resolve(handler(args));
}

export const supabase = {
  from: (table: string) => new MockQueryBuilder(db, table),
  rpc: callRpc,
};
