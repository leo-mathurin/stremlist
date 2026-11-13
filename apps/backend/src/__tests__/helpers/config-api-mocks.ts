/**
 * Mocks for the configuration API tests. The test files load them with
 * `await vi.hoisted(() => import(…))` for their `vi.mock` factories, so this
 * module must not import the app.
 */
import { vi } from "vite-plus/test";
import type { scheduleBackgroundTask } from "../../lib/background";
import type { prewarmLists } from "../../services/list-prewarm";
import { supabase } from "./mock-supabase.js";

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

export const supabaseMocks = { supabase: { ...supabase, rpc: rpcMocks.rpc } };

export const backgroundMocks = {
  scheduleBackgroundTask: vi.fn<typeof scheduleBackgroundTask>(),
};

export const prewarmMocks = { prewarmLists: vi.fn<typeof prewarmLists>() };
