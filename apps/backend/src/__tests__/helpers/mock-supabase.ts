/**
 * In-memory Supabase mock for E2E-style route tests.
 *
 * `supabase.from()` runs the chained query patterns used throughout the
 * backend against in-memory tables (supabase/store.ts), and `supabase.rpc()`
 * runs in-memory versions of the RPCs from supabase/migrations, so routes can
 * run end to end without a database.
 */
import { accountRpcs } from "./supabase/account-rpcs";
import { connectionRpcs } from "./supabase/connection-rpcs";
import { letterboxdGateRpcs } from "./supabase/letterboxd-gate-rpcs";
import { MockQueryBuilder } from "./supabase/query-builder";
import type { RpcArgs, RpcHandler } from "./supabase/rpc";
import { rpcError } from "./supabase/rpc";
import { sourceListRpcs } from "./supabase/source-list-rpcs";
import type { Result } from "./supabase/store";
import { db } from "./supabase/store";

// The in-memory tables, shared by the mock and the tests.
export { db };

const defaultRpcHandlers = new Map<string, RpcHandler>(
  Object.entries({
    ...accountRpcs,
    ...connectionRpcs,
    ...letterboxdGateRpcs,
    ...sourceListRpcs,
  }),
);

/** Per-test overrides; cleared by `resetRpc()`. */
export const rpcHandlers = new Map<string, RpcHandler>();

export function resetRpc(): void {
  rpcHandlers.clear();
}

export function callRpc(name: string, args: RpcArgs = {}): Promise<Result> {
  const handler = rpcHandlers.get(name) ?? defaultRpcHandlers.get(name);
  if (!handler) {
    return Promise.resolve(rpcError(`mock-supabase: unknown RPC ${name}`));
  }
  return Promise.resolve(handler(args));
}

export const supabase = {
  from: (table: string) => new MockQueryBuilder(db, table),
  rpc: callRpc,
};
