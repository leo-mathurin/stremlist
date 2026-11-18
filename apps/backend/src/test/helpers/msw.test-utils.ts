import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vite-plus/test";
import { r2Handlers } from "./r2.test-utils";
import { callRpc, db, rpcCalls } from "./mock-supabase";
import { postgrestHandlers } from "./supabase/postgrest";

/**
 * Starts an MSW server for the calling test file. It serves the in-memory
 * Supabase and R2 stores to the real clients. Its last handler answers every
 * other request with a network error and records it, and the test fails when
 * a request reached it. MSW's own "error" strategy lets requests for some file
 * types (.json, .html and others) through, so it alone cannot keep tests off
 * the real network.
 */
export function useMswServer() {
  const unexpected: string[] = [];
  const server = setupServer(
    ...postgrestHandlers(db, callRpc, rpcCalls),
    ...r2Handlers,
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.error();
    }),
  );
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
    expect(unexpected.splice(0), "requests that no handler covers").toEqual([]);
  });
  afterAll(() => {
    server.close();
  });
  return server;
}
