import { http } from "msw";
import type { SetupServer } from "msw/node";
import { expect, vi } from "vite-plus/test";
import type { ConnectionAccess } from "../types";
import { SourceUnavailableError } from "../types";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

export const calls: Call[] = [];

const handlerErrors: unknown[] = [];

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

/**
 * Serves the Provider API at `origins` through MSW: records every request in
 * `calls` and answers it with `respond`.
 */
export function serveApi(
  server: SetupServer,
  origins: string[],
  respond: (call: Call) => Response | Promise<Response>,
) {
  clearCalls();
  handlerErrors.length = 0;
  server.use(
    ...origins.map((origin) =>
      http.all(`${origin}/*`, async ({ request }) => {
        const text = await request.text();
        const call: Call = {
          method: request.method,
          url: new URL(request.url),
          headers: request.headers,
          body: text === "" ? undefined : text,
        };
        calls.push(call);
        try {
          return await respond(call);
        } catch (error) {
          handlerErrors.push(error);
          return new Response("The test handler failed", { status: 599 });
        }
      }),
    ),
  );
}

export function restoreStubs() {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  expect(handlerErrors).toEqual([]);
}

/**
 * A Connection that hands out `tokens` in turn, then keeps the last one. It
 * counts the access tokens asked and the refusals reported.
 */
export function connection(
  provider: ConnectionAccess["provider"],
  accountId: string,
  tokens: string[],
) {
  let index = 0;
  const access = {
    accountId,
    provider,
    username: "leo" as string | null,
    authorization: "authorization-1",
    tokenRequests: 0,
    refusals: 0,
    getAccessToken: () => {
      access.tokenRequests += 1;
      return Promise.resolve(tokens[Math.min(index++, tokens.length - 1)]);
    },
    reportRefused: () => {
      access.refusals += 1;
      return Promise.resolve();
    },
    reportWorking: () => Promise.resolve(),
  } satisfies ConnectionAccess & { tokenRequests: number; refusals: number };
  return access;
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

const DAY = 24 * 60 * 60_000;
let testTime = Date.now();

/**
 * Moves the clock one day on for each test, so that the real rate limiters,
 * which live across the tests of a file, start each test with free slots.
 * The clock keeps running, so a limiter that waits inside a test resumes.
 */
export function useFreshLimiters() {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(testTime);
  testTime += DAY;
}
