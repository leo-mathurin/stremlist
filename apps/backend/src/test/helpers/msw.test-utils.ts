import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vite-plus/test";
import { r2Handlers } from "./r2.test-utils";
import { callRpc, db, rpcCalls } from "./mock-supabase";
import { postgrestHandlers } from "./supabase/postgrest";

const unexpected: string[] = [];

/**
 * Records a request that the test did not set up an answer for, so that the
 * test fails after it ends, and answers it with a network error. The fake
 * APIs call it for a path or operation that the test did not configure. A
 * test that wants an error answer configures it explicitly.
 */
export function unexpectedRequest(request: Request, reason?: string) {
  const line = `${request.method} ${request.url}`;
  unexpected.push(reason === undefined ? line : `${line}: ${reason}`);
  return HttpResponse.error();
}

/**
 * Starts an MSW server for the calling test file. It serves the in-memory
 * Supabase and R2 stores to the real clients. Its last handler answers every
 * other request with a network error and records it, and the test fails when
 * a request reached it, when a fake API recorded an `unexpectedRequest`, or
 * when a handler threw. MSW's own "error" strategy lets requests for some
 * file types (.json, .html and others) through, so it alone cannot keep
 * tests off the real network.
 */
export function useMswServer() {
  const server = setupServer(
    ...postgrestHandlers(db, callRpc, rpcCalls),
    ...r2Handlers,
    http.all("*", ({ request }) => unexpectedRequest(request)),
  );
  server.events.on("unhandledException", ({ request, error }) => {
    unexpected.push(
      `${request.method} ${request.url}: the handler threw ${String(error)}`,
    );
  });
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
    expect(unexpected.splice(0), "unexpected requests").toEqual([]);
  });
  afterAll(() => {
    server.close();
  });
  return server;
}
