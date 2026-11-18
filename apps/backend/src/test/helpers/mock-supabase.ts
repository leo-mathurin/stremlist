import { accountRpcs } from "./supabase/account-rpcs";
import { connectionRpcs } from "./supabase/connection-rpcs";
import { letterboxdGateRpcs } from "./supabase/letterboxd-gate-rpcs";
import { monitorRunRpcs } from "./supabase/monitor-run-rpcs";
import { MockQueryBuilder } from "./supabase/query-builder";
import type { RpcCall } from "./supabase/postgrest";
import { providerOutageRpcs } from "./supabase/provider-outage-rpcs";
import type { RpcArgs, RpcHandler } from "./supabase/rpc";
import { rpcError } from "./supabase/rpc";
import { sourceListRpcs } from "./supabase/source-list-rpcs";
import { db } from "./supabase/store";

/** The in-memory tables, shared by the mock and the tests. */
export { db };

const defaultRpcHandlers = new Map<string, RpcHandler>(
  Object.entries({
    ...accountRpcs,
    ...connectionRpcs,
    ...letterboxdGateRpcs,
    ...monitorRunRpcs,
    ...providerOutageRpcs,
    ...sourceListRpcs,
  }),
);

/** Per-test overrides; cleared by `resetRpc()`. */
export const rpcHandlers = new Map<string, RpcHandler>();

/** Every RPC call that the in-memory PostgREST received, in order. */
export const rpcCalls: RpcCall[] = [];

export function resetRpc() {
  rpcHandlers.clear();
  rpcCalls.length = 0;
}

export function callRpc(name: string, args: RpcArgs = {}) {
  const outage = db.outageError(null);
  if (outage) return Promise.resolve({ data: null, error: outage });
  const handler = rpcHandlers.get(name) ?? defaultRpcHandlers.get(name);
  if (!handler) {
    return Promise.resolve(rpcError(`mock-supabase: unknown RPC ${name}`));
  }
  return Promise.resolve(handler(args));
}

/** The calls of the RPC `name`, with their arguments. */
export function rpcCallsOf(name: string) {
  return rpcCalls.filter((call) => call.name === name).map(({ args }) => args);
}

export const supabase = {
  from: (table: string) => new MockQueryBuilder(db, table),
  rpc: callRpc,
};
