import type { RpcArgs, RpcHandler } from "./rpc";
import { numberOf, rpcError, secondsFromNow, stringsOf } from "./rpc";
import type { Row } from "./store";
import { EPOCH, db, now } from "./store";

function saveConnection(args: RpcArgs) {
  const fields: Row = {
    authorization_version: crypto.randomUUID(),
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
  return { data: null, error: null };
}

function deleteConnection(args: RpcArgs) {
  const listIds = stringsOf(args.p_list_ids, "p_list_ids");
  const refs = stringsOf(args.p_source_refs, "p_source_refs");
  if (listIds.length !== refs.length) {
    return rpcError("List IDs and Source list refs must have the same length");
  }
  db.delete(
    "connections",
    (row) =>
      row.account_id === args.p_account_id && row.provider === args.p_provider,
  );
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

function findConnection(args: RpcArgs) {
  return db
    .getTable("connections")
    .find(
      (row) =>
        row.account_id === args.p_account_id &&
        row.provider === args.p_provider,
    );
}

export const connectionRpcs = {
  delete_connection: deleteConnection,
  save_connection: saveConnection,

  claim_simkl_write(args) {
    const table = db.getTable("simkl_title_writes");
    const row = table.find(
      (r) => r.account_id === args.p_account_id && r.imdb_id === args.p_imdb_id,
    );
    if (row && String(row.locked_until) > now())
      return { data: false, error: null };
    const fields = {
      lease_token: args.p_lease_token,
      locked_until: secondsFromNow(600, 1, 600),
    };
    if (row) Object.assign(row, fields);
    else
      db.insert("simkl_title_writes", {
        account_id: args.p_account_id,
        provider: "simkl",
        imdb_id: args.p_imdb_id,
        ...fields,
      });
    return { data: true, error: null };
  },

  release_simkl_write(args) {
    db.delete(
      "simkl_title_writes",
      (row) =>
        row.account_id === args.p_account_id &&
        row.imdb_id === args.p_imdb_id &&
        row.lease_token === args.p_lease_token,
    );
    return { data: null, error: null };
  },

  claim_connection_refresh(args) {
    const row = findConnection(args);
    if (!row || String(row.refresh_locked_until) > now()) {
      return { data: false, error: null };
    }
    row.refresh_locked_until = secondsFromNow(
      numberOf(args.p_lease_seconds, "p_lease_seconds"),
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

  claim_stremio_update(args) {
    const row = findStremioLink(args);
    if (!row) return { data: "none", error: null };
    if (String(row.update_locked_until) > now()) {
      return { data: "busy", error: null };
    }
    row.update_locked_until = secondsFromNow(
      numberOf(args.p_lease_seconds, "p_lease_seconds"),
      1,
      120,
    );
    row.update_lease_token = args.p_lease_token;
    return { data: "claimed", error: null };
  },

  release_stremio_update(args) {
    const row = findStremioLink(args);
    if (!row || row.update_lease_token !== args.p_lease_token) {
      return { data: false, error: null };
    }
    row.update_locked_until = EPOCH;
    row.update_lease_token = null;
    return { data: true, error: null };
  },
} satisfies Record<string, RpcHandler>;

function findStremioLink(args: RpcArgs) {
  return db
    .getTable("stremio_connections")
    .find((row) => row.account_id === args.p_account_id);
}
