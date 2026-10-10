/** In-memory versions of the Connection RPCs in supabase/migrations. */
import type { RpcArgs, RpcHandler } from "./rpc";
import { rpcError, secondsFromNow } from "./rpc";
import type { Result, Row } from "./store";
import { EPOCH, db, now } from "./store";

/** Same rules as public.save_connection. */
function saveConnection(args: RpcArgs): Result {
  const fields: Row = {
    provider_username: args.p_provider_username ?? null,
    access_token: args.p_access_token,
    refresh_token: args.p_refresh_token ?? null,
    expires_at: args.p_expires_at ?? null,
    scope: args.p_scope ?? null,
    redirect_uri: args.p_redirect_uri,
    needs_renewal_since: null,
    updated_at: now(),
  };
  const existing = findConnection(args);
  if (existing) Object.assign(existing, fields);
  else {
    db.insert("connections", {
      account_id: args.p_account_id,
      provider: args.p_provider,
      ...fields,
    });
  }
  forgetConnectionHistory(args);
  return { data: null, error: null };
}

/** Same rules as public.delete_connection. */
function deleteConnection(args: RpcArgs): Result {
  const listIds = (args.p_list_ids as string[] | null) ?? [];
  const refs = (args.p_source_refs as string[] | null) ?? [];
  if (listIds.length !== refs.length) {
    return rpcError("List IDs and Source list refs must have the same length");
  }
  db.delete(
    "connections",
    (row) =>
      row.account_id === args.p_account_id && row.provider === args.p_provider,
  );
  forgetConnectionHistory(args);
  const own = new Set(
    db
      .getTable("lists")
      .filter((row) => row.account_id === args.p_account_id)
      .map((row) => row.id),
  );
  db.delete(
    "list_sync_status",
    (row) =>
      own.has(row.list_id) &&
      row.provider === args.p_provider &&
      listIds.some(
        (listId, index) =>
          row.list_id === listId && row.source_ref === refs[index],
      ),
  );
  return { data: null, error: null };
}

function findConnection(args: RpcArgs): Row | undefined {
  return db
    .getTable("connections")
    .find(
      (row) =>
        row.account_id === args.p_account_id &&
        row.provider === args.p_provider,
    );
}

/** Same rules as public.forget_connection_history. */
function forgetConnectionHistory(args: RpcArgs): void {
  const connection = findConnection(args);
  db.delete(
    "source_list_syncs",
    (row) =>
      row.account_id === args.p_account_id &&
      row.provider === args.p_provider &&
      row.requires_connection === true &&
      (!connection ||
        (row.connection_user ?? null) !==
          (connection.provider_username ?? null)),
  );
}

export const connectionRpcs: Partial<Record<string, RpcHandler>> = {
  delete_connection: deleteConnection,
  save_connection: saveConnection,

  claim_connection_refresh(args) {
    const row = findConnection(args);
    if (!row || String(row.refresh_locked_until) > now()) {
      return { data: false, error: null };
    }
    row.refresh_locked_until = secondsFromNow(
      args.p_lease_seconds as number,
      1,
      300,
    );
    row.refresh_lease_token = args.p_lease_token;
    return { data: true, error: null };
  },

  release_connection_refresh(args) {
    const row = findConnection(args);
    if (!row || row.refresh_lease_token !== args.p_lease_token) {
      return { data: false, error: null };
    }
    row.refresh_locked_until = EPOCH;
    row.refresh_lease_token = null;
    return { data: true, error: null };
  },
};
