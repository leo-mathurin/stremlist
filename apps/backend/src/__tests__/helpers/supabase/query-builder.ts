import type { InMemoryDB, Result, Row } from "./store";
import { UNIQUE_KEYS, uniqueError, withoutUndefined } from "./store";

/**
 * The chained PostgREST query patterns used throughout the backend (select,
 * insert, upsert, update, delete with eq/in/not/order/limit/single,
 * `.select()` after a write), run against the in-memory tables.
 */
export class MockQueryBuilder {
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

      case "delete":
        return this.written(
          this.db.delete(this.tableName, (r) => this.matchesFilters(r)),
        );
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
