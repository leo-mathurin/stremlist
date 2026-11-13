/**
 * The fetch mock and helpers that every Trakt adapter test file shares.
 */
import { vi } from "vite-plus/test";
import { traktProvider } from "../../trakt";
import type { ConnectionAccess, SourceEntry } from "../../types";
import {
  clearCalls as clearRecordedCalls,
  connection as oauthConnection,
  json as oauthJson,
  stubFetch,
} from "../oauth-harness";
export {
  required,
  restoreStubs as restoreTraktTest,
  unavailableReason,
} from "../oauth-harness";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response;

/** A JSON response body, as a route answers it. */
type JsonBody = unknown[] | Record<string, unknown>;

let routes: { match: string; handler: Handler }[] = [];

/** The fetch calls so far, with their JSON bodies decoded. */
export const calls: Call[] = [];

/** Forget the calls so far, to check only the ones that follow. */
export function clearCalls(): void {
  calls.length = 0;
  clearRecordedCalls();
}

/** Route on "METHOD /path" (query ignored). Later routes win. */
export function route(
  match: string,
  handler: Handler | Response | JsonBody,
): void {
  const fn: Handler =
    typeof handler === "function"
      ? handler
      : handler instanceof Response
        ? () => handler.clone()
        : () => json(handler);
  routes.unshift({ match, handler: fn });
}

export function json(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return oauthJson(data, init.status, init.headers);
}

export function status(code: number): Response {
  return new Response(code === 204 ? null : "", { status: code });
}

/** One page of a paginated endpoint, chosen by the `page` query parameter. */
export function pages(all: unknown[][]): Handler {
  return (call) => {
    const page = Number(call.url.searchParams.get("page") ?? "1");
    return json(all[page - 1] ?? [], {
      headers: {
        "X-Pagination-Page": String(page),
        "X-Pagination-Page-Count": String(all.length),
      },
    });
  };
}

export function callsTo(path: string): Call[] {
  return calls.filter((call) => call.url.pathname === path);
}

export function resetTraktTest(): void {
  routes = [];
  vi.stubEnv("TRAKT_CLIENT_ID", "client-123");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "");
  calls.length = 0;
  stubFetch((recorded) => {
    // Trakt assertions inspect the decoded JSON body.
    const call: Call = {
      ...recorded,
      body:
        recorded.body === undefined
          ? undefined
          : (JSON.parse(recorded.body) as unknown),
    };
    calls.push(call);
    const found = routes.find(
      ({ match }) => match === `${call.method} ${call.url.pathname}`,
    );
    if (!found) throw new Error(`Unexpected ${call.method} ${call.url.href}`);
    return found.handler(call);
  });
}

export function connection(tokens: string[] = ["token-1"]) {
  return oauthConnection("trakt", "sl_testaccount0000000000", tokens);
}

export async function fetchEntries(
  ref: string,
  conn: ConnectionAccess | null = null,
): Promise<SourceEntry[]> {
  return (await traktProvider.fetchSource(ref, { connection: conn })).entries;
}
