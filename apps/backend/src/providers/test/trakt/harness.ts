import type { SetupServer } from "msw/node";
import { expect, vi } from "vite-plus/test";
import { traktProvider } from "../../trakt";
import { TRAKT_API, TRAKT_AUTH } from "../../trakt/api";
import type { ConnectionAccess } from "../../types";
import { ConnectionExpiredError } from "../../types";
import {
  clearCalls as clearRecordedCalls,
  connection as oauthConnection,
  json as oauthJson,
  restoreStubs,
  serveApi,
  useFreshLimiters,
} from "../oauth-harness";
export { required, unavailableReason } from "../oauth-harness";

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

const unexpected: string[] = [];

/** Forget the calls so far, to check only the ones that follow. */
export function clearCalls() {
  calls.length = 0;
  clearRecordedCalls();
}

/** Route on "METHOD /path" (query ignored). Later routes win. */
export function route(match: string, handler: Handler | Response | JsonBody) {
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
) {
  return oauthJson(data, init.status, init.headers);
}

export function status(code: number) {
  return new Response(code === 204 ? null : "", { status: code });
}

/** One page of a paginated endpoint, chosen by the `page` query parameter. */
export function pages(all: unknown[][]) {
  const handler: Handler = (call) => {
    const page = Number(call.url.searchParams.get("page") ?? "1");
    return json(all[page - 1] ?? [], {
      headers: {
        "X-Pagination-Page": String(page),
        "X-Pagination-Page-Count": String(all.length),
      },
    });
  };
  return handler;
}

export function callsTo(path: string) {
  return calls.filter((call) => call.url.pathname === path);
}

export function resetTraktTest(server: SetupServer) {
  useFreshLimiters();
  routes = [];
  vi.stubEnv("TRAKT_CLIENT_ID", "client-123");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "");
  calls.length = 0;
  unexpected.length = 0;
  serveApi(server, [TRAKT_API, TRAKT_AUTH], (recorded) => {
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
    if (!found) {
      unexpected.push(`${call.method} ${call.url.href}`);
      return new Response("Unexpected call", { status: 599 });
    }
    return found.handler(call);
  });
}

export function restoreTraktTest() {
  restoreStubs();
  expect(unexpected).toEqual([]);
}

export function connection(tokens: string[] = ["token-1"]) {
  return oauthConnection("trakt", "sl_testaccount0000000000", tokens);
}

/** A Connection that lost its token: it cannot give an access token. */
export function expiredConnection() {
  return {
    ...connection(),
    getAccessToken: () => Promise.reject(new ConnectionExpiredError("trakt")),
  } satisfies ConnectionAccess;
}

export async function fetchEntries(
  ref: string,
  conn: ConnectionAccess | null = null,
) {
  return (await traktProvider.fetchSource(ref, { connection: conn })).entries;
}
