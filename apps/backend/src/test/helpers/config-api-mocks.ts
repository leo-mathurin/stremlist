import { vi } from "vite-plus/test";
import type { scheduleBackgroundTask } from "../../lib/background";
import type { prewarmLists } from "../../services/list-prewarm";
import { callRpc, supabase } from "./mock-supabase.js";

/** Wraps the in-memory RPCs so tests can inspect each call. */
export const rpcMocks = { rpc: vi.fn(callRpc) };

export const supabaseMocks = { supabase: { ...supabase, rpc: rpcMocks.rpc } };

export const backgroundMocks = {
  scheduleBackgroundTask: vi.fn<typeof scheduleBackgroundTask>(),
};

export const prewarmMocks = { prewarmLists: vi.fn<typeof prewarmLists>() };
