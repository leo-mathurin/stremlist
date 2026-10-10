/** In-memory versions of the Account and List RPCs in supabase/migrations. */
import type { RpcArgs, RpcHandler } from "./rpc";
import { rpcError, secondsFromNow } from "./rpc";
import type { Result, Row } from "./store";
import { EPOCH, db, now, uniqueError } from "./store";

function replaceAccountConfig(args: RpcArgs): Result {
  const accountId = args.p_account_id as string;
  const account = db.getTable("accounts").find((row) => row.id === accountId);
  if (!account) return rpcError("Account not found");
  if (!Array.isArray(args.p_lists)) return rpcError("Lists must be an array");
  const items = args.p_lists as Row[];

  const ids = items.flatMap((item) =>
    typeof item.id === "string" ? [item.id] : [],
  );
  const lists = db.getTable("lists");
  if (
    ids.some(
      (id) =>
        !lists.some((row) => row.id === id && row.account_id === accountId),
    )
  ) {
    return rpcError("List does not belong to this account");
  }
  if (new Set(ids).size !== ids.length) return rpcError("Duplicate list ID");
  if (
    items.some(
      (item) =>
        "expected_merged_sources" in item &&
        JSON.stringify(
          lists.find((row) => row.id === item.id)?.merged_sources,
        ) !== JSON.stringify(item.expected_merged_sources),
    )
  ) {
    return rpcError("Merged Source lists changed");
  }

  const previous = listsOf(accountId);
  const deleted = lists.filter(
    (row) => row.account_id === accountId && !ids.includes(row.id as string),
  );
  db.tables.lists = lists.filter((row) => !deleted.includes(row));

  for (const item of items) {
    const fields: Row = {
      provider: item.provider,
      source_ref: item.source_ref,
      catalog_title: item.catalog_title,
      sort_option: item.sort_option,
      display_mode: item.display_mode,
      position: item.position,
    };
    const existing = db
      .getTable("lists")
      .find((row) => row.id === item.id && row.account_id === accountId);
    if (existing) {
      const next = {
        ...existing,
        ...fields,
        ...("catalog_settings" in item
          ? { catalog_settings: item.catalog_settings }
          : {}),
        ...("merged_sources" in item
          ? { merged_sources: item.merged_sources }
          : {}),
        ...("source_label" in item ? { source_label: item.source_label } : {}),
        updated_at: now(),
      };
      const conflict = db.uniqueViolation("lists", next, existing);
      if (conflict) return { data: null, error: uniqueError(conflict) };
      Object.assign(existing, next);
    } else {
      try {
        db.insert("lists", {
          ...fields,
          id: item.id,
          account_id: accountId,
          catalog_settings: item.catalog_settings ?? {},
          merged_sources: item.merged_sources ?? [],
          source_label: item.source_label ?? null,
        });
      } catch (error) {
        return { data: null, error: uniqueError(String(error)) };
      }
    }
  }

  account.rpdb_api_key = args.p_rpdb_api_key ?? null;
  account.actions_enabled = args.p_actions_enabled ?? account.actions_enabled;
  account.action_providers =
    args.p_action_providers ?? account.action_providers;
  account.new_titles_catalog =
    args.p_new_titles_catalog ?? account.new_titles_catalog;

  return {
    data: [{ previous_lists: previous, lists: listsOf(accountId) }],
    error: null,
  };
}

/** Copies of an Account's List rows, in their order. */
function listsOf(accountId: string): Row[] {
  return db
    .getTable("lists")
    .filter((row) => row.account_id === accountId)
    .sort(
      (a, b) =>
        (a.position as number) - (b.position as number) ||
        String(a.created_at).localeCompare(String(b.created_at)),
    )
    .map((row) => ({ ...row }));
}

/** Same rules as public.create_account_with_config. */
function createAccountWithConfig(args: RpcArgs): Result {
  const account = db.insert("accounts", { is_active: true });
  const saved = replaceAccountConfig({
    p_account_id: account.id,
    p_rpdb_api_key: args.p_rpdb_api_key,
    p_lists: args.p_lists,
    p_actions_enabled: null,
    p_action_providers: null,
    p_new_titles_catalog: args.p_new_titles_catalog,
  });
  if (saved.error) {
    db.delete("accounts", (row) => row.id === account.id);
    return saved;
  }
  const [{ lists }] = saved.data as { lists: Row[] }[];
  return { data: [{ account_id: account.id, lists }], error: null };
}

/** Same rules as public.copy_legacy_account. */
function copyLegacyAccount(args: RpcArgs): Result {
  const legacy = db
    .getTable("accounts")
    .find((row) => row.id === args.p_legacy_id && row.legacy_imdb_user_id);
  if (!legacy) return rpcError("Legacy account not found");
  const copy = db.insert("accounts", {
    is_active: true,
    rpdb_api_key: legacy.rpdb_api_key,
    new_titles_catalog: legacy.new_titles_catalog,
  });
  listsOf(legacy.id as string).forEach((list, position) => {
    db.insert("lists", {
      account_id: copy.id,
      provider: list.provider,
      source_ref: list.source_ref,
      catalog_title: list.catalog_title,
      sort_option: list.sort_option,
      display_mode: list.display_mode,
      position,
      catalog_settings: list.catalog_settings,
      merged_sources: list.merged_sources,
      source_label: list.source_label,
    });
  });
  legacy.moved_at = now();
  return { data: { ...copy }, error: null };
}

function findAccount(args: RpcArgs): Row | undefined {
  return db.getTable("accounts").find((row) => row.id === args.p_account_id);
}

export const accountRpcs: Partial<Record<string, RpcHandler>> = {
  copy_legacy_account: copyLegacyAccount,
  create_account_with_config: createAccountWithConfig,
  replace_account_config: replaceAccountConfig,

  request_list_prewarm(args) {
    const row = findAccount(args);
    if (!row) return { data: null, error: null };
    row.prewarm_request_generation =
      (row.prewarm_request_generation as number) + 1;
    if (String(row.prewarm_locked_until) <= now()) {
      row.prewarm_lease_token = args.p_lease_token;
      row.prewarm_locked_until = secondsFromNow(
        args.p_lease_seconds as number,
        1,
        3600,
      );
    }
    return {
      data:
        row.prewarm_lease_token === args.p_lease_token
          ? row.prewarm_request_generation
          : null,
      error: null,
    };
  },

  finish_list_prewarm(args) {
    const row = findAccount(args);
    if (!row || row.prewarm_lease_token !== args.p_lease_token) {
      return { data: null, error: null };
    }
    const pending =
      (row.prewarm_request_generation as number) >
      (args.p_completed_generation as number);
    row.prewarm_locked_until = pending
      ? secondsFromNow(args.p_lease_seconds as number, 1, 3600)
      : EPOCH;
    if (!pending) row.prewarm_lease_token = null;
    return {
      data: pending ? row.prewarm_request_generation : null,
      error: null,
    };
  },
};
