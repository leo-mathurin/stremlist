import type {
  StremioManifest,
  StremioMeta,
  UserConfigResponse,
  UserConfigUpdateWatchlist,
} from "@stremlist/shared";
import { hcWithType } from "@stremlist/backend/client";
import { BACKEND_URL } from "../env.js";

// Thin typed wrappers over the backend HTTP API. Tests use these both to
// arrange state (through real code paths) and to assert the addon protocol
// contract that Stremio clients consume.

export type CatalogMeta = StremioMeta;
type Manifest = StremioManifest;
type UserConfig = UserConfigResponse;
const api = hcWithType(BACKEND_URL);

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BACKEND_URL}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

export async function getBaseManifest(): Promise<Manifest> {
  return (await getJson<Manifest>("/manifest.json")).body;
}

export async function getUserManifest(userId: string): Promise<Manifest> {
  return (await getJson<Manifest>(`/${userId}/manifest.json`)).body;
}

export async function getConfig(
  userId: string,
): Promise<{ status: number; body: UserConfig }> {
  const response = await api[":userId"].config.$get({ param: { userId } });
  return {
    status: response.status,
    body: (await response.json()) as UserConfig,
  };
}

type ConfigWatchlistInput = UserConfigUpdateWatchlist;

export async function postConfig(
  userId: string,
  watchlists: ConfigWatchlistInput[],
  rpdbApiKey?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await api[":userId"].config.$post({
    param: { userId },
    json: { watchlists, rpdbApiKey },
  });
  return { status: response.status, body: await response.json() };
}

export async function getCatalog(
  userId: string,
  type: string,
  catalogId: string,
  skip = 0,
): Promise<{ status: number; metas: CatalogMeta[] }> {
  const extra = skip > 0 ? `/skip=${skip}` : "";
  const { status, body } = await getJson<{ metas: CatalogMeta[] }>(
    `/${userId}/catalog/${type}/${catalogId}${extra}.json`,
  );
  return { status, metas: body.metas };
}

export async function getMeta(
  userId: string,
  type: string,
  id: string,
): Promise<{ status: number; meta: CatalogMeta | null }> {
  const { status, body } = await getJson<{ meta: CatalogMeta | null }>(
    `/${userId}/meta/${type}/${id}.json`,
  );
  return { status, meta: body.meta };
}

export async function refresh(
  userId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api[":userId"].refresh.$post({
    param: { userId },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

export async function validateUser(
  userId: string,
): Promise<Record<string, unknown>> {
  const response = await api.validate[":userId"].$get({ param: { userId } });
  return (await response.json()) as Record<string, unknown>;
}

export async function validateList(
  listId: string,
): Promise<Record<string, unknown>> {
  const response = await api["validate-list"][":listId"].$get({
    param: { listId },
  });
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Bootstrap a user exactly the way a real install does: the first manifest
 * fetch upserts the user and seeds the default watchlist. Returns the config.
 */
export async function bootstrapUser(userId: string): Promise<UserConfig> {
  await getUserManifest(userId);
  const { status, body } = await getConfig(userId);
  if (status !== 200) {
    throw new Error(`bootstrapUser(${userId}) got ${status}`);
  }
  return body;
}
