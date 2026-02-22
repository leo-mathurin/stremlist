/**
 * In-memory Supabase mock for E2E-style route tests.
 *
 * Supports the chained query patterns used throughout the backend
 * (select, insert, upsert, update, delete with eq/in/order/limit/single).
 */

type Row = Record<string, unknown>;

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
    this.tables[table] = rows.map((r) => ({ ...r }));
  }
}

class MockQueryBuilder {
  private db: InMemoryDB;
  private tableName: string;
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private eqFilters: [string, unknown][] = [];
  private inFilters: [string, unknown[]][] = [];
  private orderBys: [string, { ascending: boolean }][] = [];
  private limitN: number | null = null;
  private isSingle = false;
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
    if (this.op === "insert" || this.op === "upsert") {
      this.wantReturn = true;
    } else {
      this.op = "select";
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
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
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
    this.eqFilters.push([col, val]);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.inFilters.push([col, vals]);
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

  single() {
    this.isSingle = true;
    return this;
  }

  maybeSingle() {
    this.isSingle = true;
    return this;
  }

  // ---- internals ----

  private matchesFilters(row: Row): boolean {
    for (const [col, val] of this.eqFilters) {
      if (row[col] !== val) return false;
    }
    for (const [col, vals] of this.inFilters) {
      if (!vals.includes(row[col])) return false;
    }
    return true;
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

  private applyDefaults(row: Row): Row {
    const result = { ...row };
    result.id ??= crypto.randomUUID();
    result.created_at ??= new Date().toISOString();
    result.updated_at ??= new Date().toISOString();
    return result;
  }

  private execute(): { data: unknown; error: unknown; count?: number } {
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

        if (this.limitN !== null) rows = rows.slice(0, this.limitN);

        const mapped = rows.map((r) => this.pickColumns(r));

        if (this.isSingle) {
          if (mapped.length === 0) {
            return {
              data: null,
              error: { message: "Row not found", code: "PGRST116" },
            };
          }
          return { data: mapped[0], error: null };
        }

        return { data: mapped, error: null };
      }

      case "insert": {
        const items = Array.isArray(this.payload)
          ? this.payload
          : [this.payload];
        const inserted = items.map((item) => {
          const row = this.applyDefaults(item as Row);
          table.push(row);
          return { ...row };
        });

        if (this.wantReturn) {
          if (this.isSingle) return { data: inserted[0], error: null };
          return { data: inserted, error: null };
        }
        return { data: null, error: null };
      }

      case "upsert": {
        const items = Array.isArray(this.payload)
          ? this.payload
          : [this.payload];
        const col = this.conflictCol ?? "id";
        const results = items.map((item: unknown) => {
          const record = item as Row;
          const idx = table.findIndex((r) => r[col] === record[col]);
          if (idx >= 0) {
            table[idx] = { ...table[idx], ...record };
            return { ...table[idx] };
          }
          const row = this.applyDefaults(record);
          table.push(row);
          return { ...row };
        });

        if (this.wantReturn) {
          if (this.isSingle) return { data: results[0], error: null };
          return { data: results, error: null };
        }
        return { data: null, error: null };
      }

      case "update": {
        const updated: Row[] = [];
        for (let i = 0; i < table.length; i++) {
          if (this.matchesFilters(table[i])) {
            table[i] = { ...table[i], ...(this.payload as Row) };
            updated.push({ ...table[i] });
          }
        }
        if (this.wantReturn) return { data: updated, error: null };
        return { data: null, error: null };
      }

      case "delete": {
        this.db.tables[this.tableName] = table.filter(
          (r) => !this.matchesFilters(r),
        );
        return { data: null, error: null };
      }
    }
  }

  then(
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ) {
    try {
      const result = this.execute();
      return onfulfilled ? onfulfilled(result) : result;
    } catch (e) {
      if (onrejected) return onrejected(e);
      throw e;
    }
  }
}

// Singleton used by both the mock and the tests
export const db = new InMemoryDB();

export const supabase = {
  from: (table: string) => new MockQueryBuilder(db, table),
};
