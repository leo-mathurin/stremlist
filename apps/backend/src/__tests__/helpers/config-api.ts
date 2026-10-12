/**
 * Shared setup for the configuration API tests: the Legacy alias install of
 * OWNER, request helpers and the reset that runs before each test.
 */
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { Database } from "@stremlist/shared/database.types";
import type { ProviderId } from "@stremlist/shared/providers";
import { vi } from "vitest";

import app from "../../index.js";
import { backgroundMocks, prewarmMocks, rpcMocks } from "./config-api-mocks.js";
import { LIST_IDS, seedLegacyAccount, seedList } from "./fixtures.js";
import { cache } from "./mock-list-cache.js";
import { r2Objects, r2Undeletable } from "./mock-r2.js";
import { resetProviders } from "./mock-registry.js";
import { callRpc, db } from "./mock-supabase.js";

type ReplaceConfig = Database["public"]["Functions"]["replace_account_config"];

// The legacy install of OWNER reaches its Account through the Legacy alias.
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

export function rpcArgs(call = 0): ReplaceConfig["Args"] {
  return rpcMocks.rpc.mock.calls[call][1] as ReplaceConfig["Args"];
}

export async function runScheduledTasks() {
  for (const [task] of backgroundMocks.scheduleBackgroundTask.mock.calls) {
    await (task as () => Promise<void>)();
  }
}

export function resetConfigTest() {
  db.reset();
  rpcMocks.rpc.mockReset();
  rpcMocks.rpc.mockImplementation(callRpc);
  cache.reset();
  r2Objects.clear();
  r2Undeletable.clear();
  resetProviders();
  vi.restoreAllMocks();
  legacyAccountId = seedLegacyAccount(OWNER).id;
  backgroundMocks.scheduleBackgroundTask.mockReset();
  prewarmMocks.prewarmLists.mockReset();
  prewarmMocks.prewarmLists.mockResolvedValue(undefined);
}
