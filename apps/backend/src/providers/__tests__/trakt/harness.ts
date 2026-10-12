/**
 * The fetch mock and helpers that every Trakt adapter test file shares.
 */
import { vi } from "vitest";
import { traktProvider } from "../../trakt";
import type { ConnectionAccess, SourceEntry } from "../../types";
import {
  calls as recordedCalls,
  connection as oauthConnection,
  json as oauthJson,
  stubFetch,
} from "../oauth-harness";
export {
  clearCalls,
  expectReason,
  required,
  restoreStubs as restoreTraktTest,
} from "../oauth-harness";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response;

let routes: { match: string; handler: Handler }[] = [];
export const calls = recordedCalls as unknown as Call[];

/** Route on "METHOD /path" (query ignored). Later routes win. */
export function route(
  match: string,
  handler: Handler | Response | object,
): void {
  const fn: Handler =
    typeof handler === "function"
      ? (handler as Handler)
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
  stubFetch((recorded) => {
    const call: Call = {
      ...recorded,
      body:
        recorded.body === undefined
          ? undefined
          : (JSON.parse(recorded.body) as unknown),
    };
    // Trakt assertions inspect the decoded JSON body.
    Object.assign(recorded, { body: call.body });
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
