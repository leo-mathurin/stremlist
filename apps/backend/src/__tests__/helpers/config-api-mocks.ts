/**
 * Mocks for the configuration API tests. The test files hand them to
 * `vi.mock` factories, so this module must not import the app.
 */
import type { Mock } from "vitest";
import { vi } from "vitest";

interface RpcResult {
  data: unknown;
  error: unknown;
}

/** Wraps the in-memory RPCs so tests can inspect or replace a call. */
export const rpcMocks = {
  rpc: vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  >(),
};

export const backgroundMocks: { scheduleBackgroundTask: Mock } = {
  scheduleBackgroundTask: vi.fn(),
};

export const prewarmMocks: { prewarmLists: Mock } = {
  prewarmLists: vi.fn(),
};
