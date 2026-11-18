import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vite-plus/test";

/**
 * Starts an MSW server for the calling test file. A request that no handler
 * covers fails the test, so no test reaches the real network.
 */
export function useMswServer() {
  const server = setupServer();
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
