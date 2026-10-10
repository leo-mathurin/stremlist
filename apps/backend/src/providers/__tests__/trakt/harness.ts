/**
 * The fetch mock and helpers that every Trakt adapter test file shares.
 */
import { expect, vi } from "vitest";
import { traktProvider } from "../../trakt";
import type { ConnectionAccess, SourceEntry } from "../../types";
import { SourceUnavailableError } from "../../types";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response;

export let routes: { match: string; handler: Handler }[] = [];
export let calls: Call[] = [];

/** Forget the calls so far, to check only the ones that follow. */
export function clearCalls(): void {
  calls = [];
}

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
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
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

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing Trakt adapter part");
  return value;
}

export function callsTo(path: string): Call[] {
  return calls.filter((call) => call.url.pathname === path);
}

export function resetTraktTest(): void {
  routes = [];
  calls = [];
  vi.stubEnv("TRAKT_CLIENT_ID", "client-123");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const call: Call = {
        method,
        url,
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const found = routes.find(
        ({ match }) => match === `${method} ${url.pathname}`,
      );
      if (!found) {
        return Promise.reject(new Error(`Unexpected ${method} ${url.href}`));
      }
      return Promise.resolve(found.handler(call));
    }),
  );
}

export function restoreTraktTest(): void {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

export function connection(tokens: string[] = ["token-1"]): ConnectionAccess & {
  getAccessToken: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  return {
    accountId: "sl_testaccount0000000000",
    provider: "trakt",
    username: "leo",
    getAccessToken: vi.fn(() =>
      Promise.resolve(tokens[Math.min(index++, tokens.length - 1)]),
    ),
    reportRefused: () => Promise.resolve(),
    reportWorking: () => Promise.resolve(),
  };
}

export async function fetchEntries(
  ref: string,
  conn: ConnectionAccess | null = null,
): Promise<SourceEntry[]> {
  return (await traktProvider.fetchSource(ref, { connection: conn })).entries;
}

export async function expectReason(promise: Promise<unknown>, reason: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SourceUnavailableError);
  expect((error as SourceUnavailableError).reason).toBe(reason);
}
