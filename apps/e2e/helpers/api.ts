import type {
  AccountConfigResponse,
  AccountSyncSnapshot,
  ConfigList,
  ConfigListInput,
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import type { ProviderId } from "@stremlist/shared/providers";
import { hcWithType } from "@stremlist/backend/client";
import { BACKEND_URL } from "../env.js";

// Thin typed wrappers over the backend HTTP API. Tests use these both to
// arrange state (through real code paths) and to assert the addon protocol
// contract that Stremio clients consume. An "account key" is what an Addon
// URL contains: a generated Account ID (`sl_…`) or a Legacy alias (`ur…`).

export type CatalogMeta = StremioMeta;
type Manifest = StremioManifest;
type AccountConfig = AccountConfigResponse;
const api = hcWithType(BACKEND_URL);

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BACKEND_URL}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

export async function getBaseManifest(): Promise<Manifest> {
  return (await getJson<Manifest>("/manifest.json")).body;
}

export async function getManifest(accountKey: string): Promise<Manifest> {
  return (await getJson<Manifest>(`/${accountKey}/manifest.json`)).body;
}

export async function getConfig(
  accountKey: string,
): Promise<{ status: number; body: AccountConfig }> {
  const response = await api[":accountKey"].config.$get({
    param: { accountKey },
  });
  return {
    status: response.status,
    body: (await response.json()) as AccountConfig,
  };
}

/** The sync status of an Account's Lists and its Connections (STR-58). */
export async function getSyncStatus(accountKey: string) {
  const response = await api[":accountKey"]["sync-status"].$get({
    param: { accountKey },
  });
  return {
    status: response.status,
    body: (await response.json()) as AccountSyncSnapshot,
  };
}

export interface ConfigOptions {
  rpdbApiKey?: string;
  actions?: { enabled: boolean; providers: ProviderId[] };
}

export async function postConfig(
  accountKey: string,
  lists: ConfigListInput[],
  options: ConfigOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api[":accountKey"].config.$post({
    param: { accountKey },
    json: { lists, ...options },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Create an Account the way the configure page does on its first save. */
export async function createAccount(
  lists: ConfigListInput[],
  rpdbApiKey?: string,
): Promise<{
  status: number;
  body: { accountId?: string; lists?: ConfigList[]; error?: string };
}> {
  const response = await api.accounts.$post({ json: { lists, rpdbApiKey } });
  return {
    status: response.status,
    body: (await response.json()) as {
      accountId?: string;
      lists?: ConfigList[];
      error?: string;
    },
  };
}

export async function getCatalog(
  accountKey: string,
  type: string,
  catalogId: string,
  skip = 0,
): Promise<{ status: number; metas: CatalogMeta[] }> {
  const extra = skip > 0 ? `/skip=${skip}` : "";
  const { status, body } = await getJson<{ metas: CatalogMeta[] }>(
    `/${accountKey}/catalog/${type}/${catalogId}${extra}.json`,
  );
  return { status, metas: body.metas };
}

export async function getMeta(
  accountKey: string,
  type: string,
  id: string,
): Promise<{ status: number; meta: CatalogMeta | null }> {
  const { status, body } = await getJson<{ meta: CatalogMeta | null }>(
    `/${accountKey}/meta/${type}/${id}.json`,
  );
  return { status, meta: body.meta };
}

export async function refresh(
  accountKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api[":accountKey"].refresh.$post({
    param: { accountKey },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** What the configure page asks when the user adds a pasted link. */
export async function resolveLink(
  input: string,
  accountKey?: string,
  backendUrl = BACKEND_URL,
): Promise<Record<string, unknown>> {
  const response = await hcWithType(backendUrl).links.resolve.$post({
    json: { input, accountKey },
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Give a Legacy alias install a private Addon URL. */
export async function upgrade(
  accountKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api[":accountKey"].upgrade.$post({
    param: { accountKey },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/**
 * Bootstrap a Legacy alias install exactly the way an old Stremio install
 * does: the first manifest fetch creates the legacy Account and its default
 * IMDb watchlist List. Returns the configuration.
 */
export async function bootstrapLegacy(
  imdbUserId: string,
): Promise<AccountConfig> {
  await getManifest(imdbUserId);
  const { status, body } = await getConfig(imdbUserId);
  if (status !== 200) {
    throw new Error(`bootstrapLegacy(${imdbUserId}) got ${status}`);
  }
  return body;
}

/** The Lists of a saved configuration as a save payload (same IDs). */
export function asInput(lists: ConfigList[]): ConfigListInput[] {
  return lists.map((list) => ({
    id: list.id,
    provider: list.provider,
    sourceRef: list.sourceRef,
    catalogTitle: list.catalogTitle,
    sortOption: list.sortOption,
    displayMode: list.displayMode,
    catalogSettings: list.catalogSettings,
    mergedSources: list.mergedSources,
  }));
}
