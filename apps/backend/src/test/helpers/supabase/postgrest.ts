import { http, HttpResponse } from "msw";
import { isRecord } from "../json";
import { MockQueryBuilder } from "./query-builder";
import type { RpcArgs } from "./rpc";
import type { InMemoryDB, Result, Row } from "./store";

/** One RPC call that the in-memory PostgREST received. */
export interface RpcCall {
  name: string;
  args: RpcArgs;
}

type CallRpc = (name: string, args: RpcArgs) => Promise<Result>;

const SINGLE = "application/vnd.pgrst.object+json";
const RESERVED = new Set(["select", "order", "limit", "offset", "columns"]);

function supabaseUrl() {
  return process.env.SUPABASE_URL ?? "http://supabase.test";
}

function listValues(raw: string) {
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (quoted && char === "\\") {
      current += inner[index + 1] ?? "";
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (inner.length > 0) values.push(current);
  return values;
}

function text(value: unknown) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function literal(raw: string) {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`in-memory PostgREST: unsupported is.${raw}`);
}

function atLeast(value: unknown, raw: string) {
  if (typeof value === "number") return value >= Number(raw);
  if (typeof value === "string") return value >= raw;
  return false;
}

function filterOf(column: string, expression: string) {
  const negated = expression.startsWith("not.");
  const rest = negated ? expression.slice(4) : expression;
  const dot = rest.indexOf(".");
  const operator = rest.slice(0, dot);
  const raw = rest.slice(dot + 1);
  let matches: (row: Row) => boolean;
  switch (operator) {
    case "eq":
      matches = (row) => text(row[column]) === raw;
      break;
    case "in": {
      const values = listValues(raw);
      matches = (row) => values.includes(text(row[column]) ?? "\u0000");
      break;
    }
    case "is": {
      const expected = literal(raw);
      matches = (row) => (row[column] ?? null) === expected;
      break;
    }
    case "gte":
      matches = (row) => atLeast(row[column], raw);
      break;
    default:
      throw new Error(`in-memory PostgREST: unsupported ${operator} filter`);
  }
  return negated ? (row: Row) => !matches(row) : matches;
}

function orderOf(builder: MockQueryBuilder, order: string) {
  for (const term of order.split(",")) {
    const [column, direction] = term.split(".");
    builder.order(column, { ascending: direction !== "desc" });
  }
}

function errorStatus(error: unknown) {
  const code = isRecord(error) ? error.code : undefined;
  if (code === "23505") return 409;
  if (code === "PGRST116") return 406;
  return 500;
}

function respond(result: Result, request: Request) {
  if (result.error) {
    return HttpResponse.json(result.error, {
      status: errorStatus(result.error),
    });
  }
  const headers = new Headers();
  if (typeof result.count === "number") {
    headers.set("Content-Range", `*/${result.count}`);
  }
  if (request.method === "HEAD" || result.data === null) {
    return new HttpResponse(null, { status: 200, headers });
  }
  return HttpResponse.json(result.data, { headers });
}

function stalled(db: InMemoryDB, table: string, request: Request) {
  return new Promise<Response>((resolve, reject) => {
    const release = () => {
      resolve(
        HttpResponse.json(
          { message: `${table} stalled until the test ended` },
          { status: 500 },
        ),
      );
    };
    db.stalls.add(release);
    request.signal.addEventListener("abort", () => {
      db.stalls.delete(release);
      reject(new Error("The request was aborted"));
    });
  });
}

async function bodyOf(request: Request) {
  const raw = await request.text();
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  return parsed;
}

function rowsOf(body: unknown) {
  const items = Array.isArray(body) ? body : [body];
  return items.map((item: unknown) => {
    if (!isRecord(item)) throw new Error("in-memory PostgREST: bad row");
    return item;
  });
}

async function tableQuery(db: InMemoryDB, table: string, request: Request) {
  const url = new URL(request.url);
  const prefer = request.headers.get("Prefer") ?? "";
  const params = url.searchParams;
  const builder = new MockQueryBuilder(db, table);
  const select = params.get("select") ?? undefined;
  const count = /count=(exact|planned|estimated)/.exec(prefer)?.[1];

  switch (request.method) {
    case "GET":
    case "HEAD":
      builder.select(select, {
        count,
        head: request.method === "HEAD",
      });
      break;
    case "POST": {
      const rows = rowsOf(await bodyOf(request));
      if (prefer.includes("resolution=merge-duplicates")) {
        builder.upsert(rows, {
          onConflict: params.get("on_conflict") ?? undefined,
        });
      } else if (prefer.includes("resolution=ignore-duplicates")) {
        throw new Error("in-memory PostgREST: unsupported ignoreDuplicates");
      } else {
        builder.insert(rows);
      }
      break;
    }
    case "PATCH": {
      const [changes] = rowsOf(await bodyOf(request));
      builder.update(changes);
      break;
    }
    case "DELETE":
      builder.delete();
      break;
    default:
      throw new Error(`in-memory PostgREST: unsupported ${request.method}`);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (prefer.includes("return=representation")) builder.select(select);
  }
  for (const [name, value] of params) {
    if (RESERVED.has(name) || name === "on_conflict") continue;
    builder.where(filterOf(name, value));
  }
  const order = params.get("order");
  if (order) orderOf(builder, order);
  const limit = params.get("limit");
  if (limit !== null) {
    const offset = Number(params.get("offset") ?? 0);
    builder.range(offset, offset + Number(limit) - 1);
  }
  if (request.headers.get("Accept")?.startsWith(SINGLE)) builder.single();

  if (db.stalledTables.has(table)) return stalled(db, table, request);
  return respond(await builder.run(), request);
}

function singleOf(result: Result, request: Request) {
  if (
    result.error ||
    !request.headers.get("Accept")?.startsWith(SINGLE) ||
    !Array.isArray(result.data)
  ) {
    return result;
  }
  const rows: unknown[] = result.data;
  if (rows.length === 1) return { ...result, data: rows[0] };
  return {
    data: null,
    error: {
      message: "JSON object requested, multiple (or no) rows returned",
      code: "PGRST116",
    },
  };
}

/**
 * MSW handlers that serve the in-memory tables and RPCs over the PostgREST
 * HTTP API, so the real Supabase client reads and writes them.
 */
export function postgrestHandlers(
  db: InMemoryDB,
  callRpc: CallRpc,
  rpcCalls: RpcCall[],
) {
  const base = `${supabaseUrl()}/rest/v1`;
  return [
    http.post(`${base}/rpc/:name`, async ({ request, params }) => {
      const name = String(params.name);
      const body = await bodyOf(request);
      const args = isRecord(body) ? body : {};
      rpcCalls.push({ name, args });
      return respond(singleOf(await callRpc(name, args), request), request);
    }),
    http.all(`${base}/:table`, ({ request, params }) =>
      tableQuery(db, String(params.table), request),
    ),
  ];
}
