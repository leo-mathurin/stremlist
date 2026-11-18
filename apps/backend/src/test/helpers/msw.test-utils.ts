import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vite-plus/test";
import { r2Handlers } from "./r2.test-utils";
import { callRpc, db, rpcCalls } from "./mock-supabase";
import { postgrestHandlers } from "./supabase/postgrest";

/**
 * Starts an MSW server for the calling test file. It serves the in-memory
 * Supabase and R2 stores to the real clients. A request that no handler
 * covers fails the test, so no test reaches the real network.
 */
export function useMswServer() {
  const server = setupServer(
    ...postgrestHandlers(db, callRpc, rpcCalls),
    ...r2Handlers,
  );
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
  return server;
}
