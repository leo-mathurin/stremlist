import type { CatalogPreviewResponse } from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { ListSource } from "@stremlist/shared/list-merge";
import type {
  AccountConfigResponse,
  AccountSyncSnapshot,
  ConfigList,
  ConfigListInput,
  NewTitlesSummary,
  StremioManifest,
  StremioMeta,
  StremioStream,
} from "@stremlist/shared/stremio.types";
import type { PosterSource } from "@stremlist/shared/poster";
import type { ProviderId } from "@stremlist/shared/providers";
import { hcWithType } from "@stremlist/backend/client";
import { BACKEND_URL } from "../env.js";
import { type Guard, isRecord, isString, optional, parsed } from "./json.js";

export type CatalogMeta = StremioMeta;

interface ApiResponse<T> {
  status: number;
  body: T;
}

interface ConfigOptions {
  rpdbApiKey?: string;
  posterSource?: PosterSource;
  actions?: { enabled: boolean; providers: ProviderId[] };
}

/** What `POST /:accountKey/refresh` answers. */
export interface RefreshResult {
  refreshed: number;
  failed: number;
  newTitles: NewTitlesSummary | null;
}

/** The body of `POST /lists/preview`. */
export interface PreviewInput {
  accountKey?: string;
  provider: ProviderId;
  sourceRef: string;
  sortOption: string;
  displayMode?: DisplayMode;
  catalogSettings?: CatalogSettings;
  mergedSources?: ListSource[];
}

interface CatalogExtra {
  search?: string;
  skip?: number;
}

/** A List of a save payload: `provider` and `sourceRef`, sorted by date added. */
export function listInput(
  provider: ProviderId,
  sourceRef: string,
  extra: Partial<ConfigListInput> = {},
) {
  return {
    provider,
    sourceRef,
    sortOption: "added_at-asc",
    ...extra,
  } satisfies ConfigListInput;
}

/** The Lists of a saved configuration as a save payload (same IDs). */
export function asInput(lists: ConfigList[]) {
  const inputs: ConfigListInput[] = lists.map((list) => ({
    id: list.id,
    provider: list.provider,
    sourceRef: list.sourceRef,
    catalogTitle: list.catalogTitle,
    sortOption: list.sortOption,
    displayMode: list.displayMode,
    catalogSettings: list.catalogSettings,
    mergedSources: list.mergedSources,
  }));
  return inputs;
}

/** The body of a 200 answer; any other status fails the test. */
export function ok<T>(response: ApiResponse<T>) {
  if (response.status !== 200) {
    throw new Error(
      `Expected HTTP 200, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

type AnyBody = Record<string, unknown>;

function isErrorBody(value: unknown): value is AnyBody {
  return isRecord(value) && ("error" in value || "reason" in value);
}

export function isManifest(value: unknown): value is StremioManifest {
  return (
    isRecord(value) &&
    isString(value.id) &&
    Array.isArray(value.resources) &&
    Array.isArray(value.catalogs)
  );
}

function isConfig(value: unknown): value is AccountConfigResponse {
  return (
    isErrorBody(value) ||
    (isRecord(value) && Array.isArray(value.lists) && isRecord(value.newTitles))
  );
}

function isSyncSnapshot(value: unknown): value is AccountSyncSnapshot {
  return (
    isErrorBody(value) ||
    (isRecord(value) &&
      isRecord(value.syncStatus) &&
      Array.isArray(value.connections))
  );
}

function isAccountAnswer(
  value: unknown,
): value is { accountId?: string; lists?: ConfigList[]; error?: string } {
  return (
    isRecord(value) &&
    optional(value.accountId, isString) &&
    optional(value.lists, Array.isArray) &&
    optional(value.error, isString)
  );
}

export function isCatalog(value: unknown): value is { metas: CatalogMeta[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.metas) &&
    value.metas.every((meta) => isRecord(meta) && isString(meta.id))
  );
}

export function isMetaAnswer(
  value: unknown,
): value is { meta: CatalogMeta | null } {
  return isRecord(value) && (value.meta === null || isRecord(value.meta));
}

function isStreams(
  value: unknown,
): value is { streams: StremioStream[]; cacheMaxAge?: number } {
  return isRecord(value) && Array.isArray(value.streams);
}

function isProviders(
  value: unknown,
): value is { providers: { id: ProviderId; enabled: boolean }[] } {
  return isRecord(value) && Array.isArray(value.providers);
}

function isPreview(value: unknown): value is CatalogPreviewResponse {
  return isRecord(value);
}

function isSources(
  value: unknown,
): value is { sources: { ref: string; label: string }[] } {
  return (
    isErrorBody(value) || (isRecord(value) && Array.isArray(value.sources))
  );
}

function isStart(
  value: unknown,
): value is { authorizeUrl: string; browserKey: string } {
  return (
    isErrorBody(value) ||
    (isRecord(value) &&
      isString(value.authorizeUrl) &&
      isString(value.browserKey))
  );
}

function isCompletion(value: unknown): value is {
  ok?: true;
  accountId?: string;
  created?: boolean;
  reason?: string;
} {
  return (
    isRecord(value) &&
    optional(value.ok, (ok) => ok === true) &&
    optional(value.accountId, isString) &&
    optional(value.reason, isString)
  );
}

/** A save that created an Account (`POST /accounts`). */
export function hasAccountId(value: unknown): value is { accountId: string } {
  return isRecord(value) && isString(value.accountId);
}

/** The answer of `POST /:accountKey/refresh` that a test expects. */
export function isRefreshResult(value: unknown): value is RefreshResult {
  return (
    isRecord(value) &&
    typeof value.refreshed === "number" &&
    typeof value.failed === "number" &&
    "newTitles" in value
  );
}

async function answer<T>(
  response: { status: number; json(): Promise<unknown> },
  is: Guard<T>,
) {
  return {
    status: response.status,
    body: parsed(await response.json(), is, `body (${response.status})`),
  };
}

/** The readers and writers of the backend at `baseUrl`. */
export function apiAt(baseUrl: string) {
  const client = hcWithType(baseUrl);

  async function send<T>(
    path: string,
    is: Guard<T>,
    init: { method?: string; json?: unknown } = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers:
        init.json === undefined ? {} : { "Content-Type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      redirect: "manual",
    });
    const text = await response.text();
    return {
      status: response.status,
      body: parsed(
        text ? JSON.parse(text) : null,
        is,
        `body of ${path} (${response.status})`,
      ),
    };
  }

  async function getManifest(accountKey: string) {
    return (await send(`/${accountKey}/manifest.json`, isManifest)).body;
  }

  async function getConfig(accountKey: string) {
    return answer(
      await client[":accountKey"].config.$get({ param: { accountKey } }),
      isConfig,
    );
  }

  async function getCatalog(
    accountKey: string,
    type: string,
    catalogId: string,
    extra: CatalogExtra = {},
  ) {
    const segments = [
      ...(extra.search !== undefined
        ? [`search=${encodeURIComponent(extra.search)}`]
        : []),
      ...(extra.skip ? [`skip=${extra.skip}`] : []),
    ];
    const suffix = segments.length > 0 ? `/${segments.join("&")}` : "";
    const { status, body } = await send(
      `/${accountKey}/catalog/${type}/${catalogId}${suffix}.json`,
      isCatalog,
    );
    return { status, metas: body.metas };
  }

  return {
    async getBaseManifest() {
      return (await send("/manifest.json", isManifest)).body;
    },

    getManifest,
    getConfig,

    async getSyncStatus(accountKey: string) {
      return answer(
        await client[":accountKey"]["sync-status"].$get({
          param: { accountKey },
        }),
        isSyncSnapshot,
      );
    },

    async postConfig(
      accountKey: string,
      lists: ConfigListInput[],
      options: ConfigOptions = {},
    ) {
      return answer(
        await client[":accountKey"].config.$post({
          param: { accountKey },
          json: { lists, ...options },
        }),
        isRecord,
      );
    },

    async createAccount(lists: ConfigListInput[], rpdbApiKey?: string) {
      return answer(
        await client.accounts.$post({ json: { lists, rpdbApiKey } }),
        isAccountAnswer,
      );
    },

    getCatalog,

    async listCatalogNames(accountKey: string, listId: string, type: string) {
      const { status, metas } = await getCatalog(
        accountKey,
        type,
        `wl-${listId}-${type}`,
      );
      if (status !== 200) {
        throw new Error(`Catalog of List ${listId} answered ${status}`);
      }
      return metas.map((meta) => meta.name);
    },

    async getMeta(accountKey: string, type: string, id: string) {
      const { status, body } = await send(
        `/${accountKey}/meta/${type}/${id}.json`,
        isMetaAnswer,
      );
      return { status, meta: body.meta };
    },

    async getStreams(accountKey: string, type: string, id: string) {
      return send(`/${accountKey}/stream/${type}/${id}.json`, isStreams);
    },

    async refresh(accountKey: string) {
      return answer(
        await client[":accountKey"].refresh.$post({ param: { accountKey } }),
        isRecord,
      );
    },

    async resolveLink(input: string, accountKey?: string) {
      const response = await client.links.resolve.$post({
        json: { input, accountKey },
      });
      const body: Record<string, unknown> = await response.json();
      return body;
    },

    async upgrade(accountKey: string) {
      const { body: shown } = await getConfig(accountKey);
      return answer(
        await client.accounts.$post({
          json: {
            rpdbApiKey: shown.rpdbApiKey ?? undefined,
            lists: shown.lists,
            newTitles: {
              enabled: shown.newTitles.enabled,
              settings: shown.newTitles.settings,
            },
          },
        }),
        isAccountAnswer,
      );
    },

    async bootstrapLegacy(imdbUserId: string) {
      await getManifest(imdbUserId);
      const { status, body } = await getConfig(imdbUserId);
      if (status !== 200) {
        throw new Error(`bootstrapLegacy(${imdbUserId}) got ${status}`);
      }
      return body;
    },

    async getProviders() {
      return send("/providers", isProviders);
    },

    async previewList(input: PreviewInput) {
      return send("/lists/preview", isPreview, { json: input });
    },

    async getConnectionSources(accountKey: string, provider: ProviderId) {
      return send(`/${accountKey}/connections/${provider}/sources`, isSources);
    },

    async startConnection(accountKey: string | null, provider: ProviderId) {
      return send(
        accountKey
          ? `/${accountKey}/connections/${provider}/start`
          : `/connections/${provider}/start`,
        isStart,
        { method: "POST" },
      );
    },

    async completeConnection(
      provider: ProviderId,
      json: {
        state: string;
        code: string;
        browserKey: string;
        setup?: { lists: ConfigListInput[] };
      },
    ) {
      return send(`/connections/${provider}/complete`, isCompletion, {
        json,
      });
    },

    async disconnect(accountKey: string, provider: ProviderId) {
      return send(`/${accountKey}/connections/${provider}`, isRecord, {
        method: "DELETE",
      });
    },

    async oauthCallback(
      provider: ProviderId,
      params: Record<string, string> = {},
    ) {
      const query = new URLSearchParams(params).toString();
      const response = await fetch(
        `${baseUrl}/oauth/${provider}/callback${query ? `?${query}` : ""}`,
        { redirect: "manual" },
      );
      await response.body?.cancel();
      return {
        status: response.status,
        location: response.headers.get("location"),
      };
    },
  };
}

export type Api = ReturnType<typeof apiAt>;

/** The Playwright backend (BACKEND_URL). */
export const api = apiAt(BACKEND_URL);

export const getBaseManifest = () => api.getBaseManifest();
export const getManifest = (accountKey: string) => api.getManifest(accountKey);
export const getConfig = (accountKey: string) => api.getConfig(accountKey);
export const getSyncStatus = (accountKey: string) =>
  api.getSyncStatus(accountKey);
export const postConfig = (...args: Parameters<Api["postConfig"]>) =>
  api.postConfig(...args);
export const createAccount = (...args: Parameters<Api["createAccount"]>) =>
  api.createAccount(...args);
export const getCatalog = (...args: Parameters<Api["getCatalog"]>) =>
  api.getCatalog(...args);
export const getMeta = (...args: Parameters<Api["getMeta"]>) =>
  api.getMeta(...args);
export const refresh = (accountKey: string) => api.refresh(accountKey);
export const resolveLink = (...args: Parameters<Api["resolveLink"]>) =>
  api.resolveLink(...args);
export const bootstrapLegacy = (imdbUserId: string) =>
  api.bootstrapLegacy(imdbUserId);
