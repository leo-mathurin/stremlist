import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { Database } from "@stremlist/shared/database";
import type { ProviderId } from "@stremlist/shared/providers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import type { ListSource } from "@stremlist/shared/list-merge";
import app from "../../index.js";
import { sourceCaches } from "../../services/merged-lists";
import { LIST_IDS, seedLegacyAccount, seedList } from "./account.fixture.js";
import { cache } from "./list-cache.test-utils.js";
import { json } from "./json.js";
import { db, resetRpc, rpcCallsOf } from "./mock-supabase.js";
import { resetR2 } from "./r2.test-utils.js";

type ReplaceConfig = Database["public"]["Functions"]["replace_account_config"];

const replaceConfigArgs = z.object({
  p_account_id: z.string(),
  p_action_providers: z.array(z.string()).nullable(),
  p_actions_enabled: z.boolean().nullable(),
  p_lists: json,
  p_new_titles_catalog: z.boolean().nullable().optional(),
  p_rpdb_api_key: z.string().nullable(),
}) satisfies z.ZodType<ReplaceConfig["Args"]>;

/** The real Provider adapters of the app, for spies that only observe them. */
export { getProvider } from "../../providers/registry";

/** The legacy install of OWNER reaches its Account through the Legacy alias. */
export const OWNER = "ur12345678";
export const OTHER_IMDB = "ur87654321";

export const [UUID_1, UUID_2] = LIST_IDS;

export let legacyAccountId = "";

export function seedWatchlist(overrides: {
  id: string;
  accountId?: string;
  provider?: ProviderId;
  sourceRef?: string;
  catalogTitle?: string;
  sortOption?: string;
  position?: number;
}) {
  seedList(overrides.accountId ?? legacyAccountId, {
    id: overrides.id,
    provider: overrides.provider ?? "imdb",
    source_ref: overrides.sourceRef ?? OWNER,
    catalog_title: overrides.catalogTitle ?? "",
    sort_option: overrides.sortOption ?? "added_at-asc",
    position: overrides.position ?? 0,
  });
}

interface ListBody {
  id?: string;
  provider?: ProviderId;
  sourceRef: string;
  catalogTitle?: string;
  sortOption: string;
  displayMode?: DisplayMode;
  position?: number;
  catalogSettings?: CatalogSettings;
}

interface ConfigBody {
  rpdbApiKey?: string;
  lists: ListBody[];
  actions?: { enabled: boolean; providers: ProviderId[] };
}

export function withProviders(body: ConfigBody) {
  return {
    ...body,
    lists: body.lists.map((list) => ({ provider: "imdb", ...list })),
  };
}

export function getConfig(accountKey: string) {
  return app.request(`/${accountKey}/config`);
}

export function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function postConfig(accountKey: string, body: ConfigBody) {
  return postJson(`/${accountKey}/config`, withProviders(body));
}

/** The arguments of the `call`-th `replace_account_config` RPC. */
export function rpcArgs(call = 0) {
  return replaceConfigArgs.parse(rpcCallsOf("replace_account_config")[call]);
}

export function resetConfigTest() {
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  vi.restoreAllMocks();
  legacyAccountId = seedLegacyAccount(OWNER).id;
}

/** The cache keys of a List's Source lists, the first Source list first. */
export function sourceCacheKeys(listId: string, sources: ListSource[]) {
  const [first, ...merged] = sources;
  return sourceCaches({ id: listId, ...first, mergedSources: merged }).map(
    ({ cacheKey }) => cacheKey,
  );
}
