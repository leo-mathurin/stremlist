import { expect, vi } from "vite-plus/test";
import type * as Http from "../http";
import type { ConnectionAccess } from "../types";
import { SourceUnavailableError } from "../types";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

export const calls: Call[] = [];

/** Forget the calls so far, to check only the ones that follow. */
export function clearCalls() {
  calls.length = 0;
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Record every fetch in `calls` and answer it with `respond`. */
export function stubFetch(
  respond: (call: Call) => Response | Promise<Response>,
) {
  clearCalls();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url: new URL(input instanceof Request ? input.url : input),
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    }),
  );
}

export function restoreStubs() {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

/** A Connection that hands out `tokens` in turn, then keeps the last one. */
export function connection(
  provider: ConnectionAccess["provider"],
  accountId: string,
  tokens: string[],
) {
  let index = 0;
  return {
    accountId,
    provider,
    username: "leo" as string | null,
    authorization: "authorization-1",
    getAccessToken: vi.fn(() =>
      Promise.resolve(tokens[Math.min(index++, tokens.length - 1)]),
    ),
    reportRefused: vi.fn(() => Promise.resolve()),
    reportWorking: () => Promise.resolve(),
  } satisfies ConnectionAccess;
}

export function required<T>(value: T | undefined) {
  if (value === undefined) throw new Error("Missing adapter part");
  return value;
}

/** The reason of the SourceUnavailableError that `promise` rejects with. */
export async function unavailableReason(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SourceUnavailableError);
  if (!(error instanceof SourceUnavailableError)) throw error;
  return error.reason;
}

/** Limiters that never wait; `limiters` keeps the limits each was built with. */
export const limiters: [number, number][] = [];

export function httpModule(actual: typeof Http) {
  class RateLimiter {
    constructor(limit: number, windowMs: number) {
      limiters.push([limit, windowMs]);
    }
    acquire() {
      return Promise.resolve();
    }
  }
  return { ...actual, RateLimiter };
}
