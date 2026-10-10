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
import type { ProviderId } from "@stremlist/shared/providers";
import { hcWithType } from "@stremlist/backend/client";
import { BACKEND_URL } from "../env.js";

// Thin typed wrappers over the backend HTTP API. Tests use these both to
// arrange state (through real code paths) and to assert the addon protocol
// contract that Stremio clients consume. An "account key" is what an Addon
// URL contains: a generated Account ID (`sl_…`) or a Legacy alias (`ur…`).
// `apiAt(url)` talks to one backend; `api` and the named exports below talk
// to the Playwright backend (BACKEND_URL), and a fixture backend has its own.

export type CatalogMeta = StremioMeta;

export interface ApiResponse<T> {
  status: number;
  body: T;
}

export interface ConfigOptions {
  rpdbApiKey?: string;
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

/** Stremio catalog extras: `/search=…` and `/skip=…` path segments. */
export interface CatalogExtra {
  search?: string;
  skip?: number;
}

/** A List of a save payload: `provider` and `sourceRef`, sorted by date added. */
export function listInput(
  provider: ProviderId,
  sourceRef: string,
  extra: Partial<ConfigListInput> = {},
): ConfigListInput {
  return { provider, sourceRef, sortOption: "added_at-asc", ...extra };
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

/** The body of a 200 answer; any other status fails the test. */
export function ok<T>(response: ApiResponse<T>): T {
  if (response.status !== 200) {
    throw new Error(
      `Expected HTTP 200, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

/** The readers and writers of the backend at `baseUrl`. */
export function apiAt(baseUrl: string) {
  const client = hcWithType(baseUrl);

  /** A request that does not follow redirects; an empty body is null. */
  async function send<T>(
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<ApiResponse<T>> {
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
      body: (text ? JSON.parse(text) : null) as T,
    };
  }

  async function getManifest(accountKey: string): Promise<StremioManifest> {
    return (await send<StremioManifest>(`/${accountKey}/manifest.json`)).body;
  }

  async function getConfig(
    accountKey: string,
  ): Promise<ApiResponse<AccountConfigResponse>> {
    const response = await client[":accountKey"].config.$get({
      param: { accountKey },
    });
    return {
      status: response.status,
      body: (await response.json()) as AccountConfigResponse,
    };
  }

  async function getCatalog(
    accountKey: string,
    type: string,
    catalogId: string,
    extra: CatalogExtra = {},
  ): Promise<{ status: number; metas: CatalogMeta[] }> {
    const segments = [
      ...(extra.search !== undefined
        ? [`search=${encodeURIComponent(extra.search)}`]
        : []),
      ...(extra.skip ? [`skip=${extra.skip}`] : []),
    ];
    const suffix = segments.length > 0 ? `/${segments.join("&")}` : "";
    const { status, body } = await send<{ metas: CatalogMeta[] }>(
      `/${accountKey}/catalog/${type}/${catalogId}${suffix}.json`,
    );
    return { status, metas: body.metas };
  }

  return {
    url: baseUrl,

    async getBaseManifest(): Promise<StremioManifest> {
      return (await send<StremioManifest>("/manifest.json")).body;
    },

    getManifest,
    getConfig,

    /** The sync status of an Account's Lists and its Connections (STR-58). */
    async getSyncStatus(
      accountKey: string,
    ): Promise<ApiResponse<AccountSyncSnapshot>> {
      const response = await client[":accountKey"]["sync-status"].$get({
        param: { accountKey },
      });
      return {
        status: response.status,
        body: (await response.json()) as AccountSyncSnapshot,
      };
    },

    async postConfig<T = Record<string, unknown>>(
      accountKey: string,
      lists: ConfigListInput[],
      options: ConfigOptions = {},
    ): Promise<ApiResponse<T>> {
      const response = await client[":accountKey"].config.$post({
        param: { accountKey },
        json: { lists, ...options },
      });
      return { status: response.status, body: (await response.json()) as T };
    },

    /** Create an Account the way the configure page does on its first save. */
    async createAccount(
      lists: ConfigListInput[],
      rpdbApiKey?: string,
    ): Promise<
      ApiResponse<{ accountId?: string; lists?: ConfigList[]; error?: string }>
    > {
      const response = await client.accounts.$post({
        json: { lists, rpdbApiKey },
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          accountId?: string;
          lists?: ConfigList[];
          error?: string;
        },
      };
    },

    getCatalog,

    /** The names in the Catalog of `type` of one List; fails unless 200. */
    async listCatalogNames(
      accountKey: string,
      listId: string,
      type: string,
    ): Promise<string[]> {
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

    async getMeta(
      accountKey: string,
      type: string,
      id: string,
    ): Promise<{ status: number; meta: CatalogMeta | null }> {
      const { status, body } = await send<{ meta: CatalogMeta | null }>(
        `/${accountKey}/meta/${type}/${id}.json`,
      );
      return { status, meta: body.meta };
    },

    /** The Action entries that Stremio shows for a Title. */
    async getStreams(
      accountKey: string,
      type: string,
      id: string,
    ): Promise<
      ApiResponse<{ streams: StremioStream[]; cacheMaxAge?: number }>
    > {
      return send(`/${accountKey}/stream/${type}/${id}.json`);
    },

    async refresh<T = Record<string, unknown>>(
      accountKey: string,
    ): Promise<ApiResponse<T>> {
      const response = await client[":accountKey"].refresh.$post({
        param: { accountKey },
      });
      return { status: response.status, body: (await response.json()) as T };
    },

    /** What the configure page asks when the user adds a pasted link. */
    async resolveLink(
      input: string,
      accountKey?: string,
    ): Promise<Record<string, unknown>> {
      const response = await client.links.resolve.$post({
        json: { input, accountKey },
      });
      return (await response.json()) as Record<string, unknown>;
    },

    /** Give a Legacy alias install a private Addon URL. */
    async upgrade(
      accountKey: string,
    ): Promise<ApiResponse<Record<string, unknown>>> {
      const response = await client[":accountKey"].upgrade.$post({
        param: { accountKey },
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },

    /**
     * Bootstrap a Legacy alias install exactly the way an old Stremio install
     * does: the first manifest fetch creates the legacy Account and its
     * default IMDb watchlist List. Returns the configuration.
     */
    async bootstrapLegacy(imdbUserId: string): Promise<AccountConfigResponse> {
      await getManifest(imdbUserId);
      const { status, body } = await getConfig(imdbUserId);
      if (status !== 200) {
        throw new Error(`bootstrapLegacy(${imdbUserId}) got ${status}`);
      }
      return body;
    },

    async getProviders(): Promise<
      ApiResponse<{ providers: { id: ProviderId; enabled: boolean }[] }>
    > {
      return send("/providers");
    },

    async previewList(
      input: PreviewInput,
    ): Promise<ApiResponse<CatalogPreviewResponse>> {
      return send("/lists/preview", { json: input });
    },

    /** The Source lists that a Connection offers (Quick add). */
    async getConnectionSources(
      accountKey: string,
      provider: ProviderId,
    ): Promise<ApiResponse<{ sources: { ref: string; label: string }[] }>> {
      return send(`/${accountKey}/connections/${provider}/sources`);
    },

    /** Start an OAuth authorization, as the Connect button does. */
    async startConnection(
      accountKey: string,
      provider: ProviderId,
    ): Promise<ApiResponse<{ authorizeUrl: string }>> {
      return send(`/${accountKey}/connections/${provider}/start`, {
        method: "POST",
      });
    },

    async disconnect(
      accountKey: string,
      provider: ProviderId,
    ): Promise<ApiResponse<Record<string, unknown>>> {
      return send(`/${accountKey}/connections/${provider}`, {
        method: "DELETE",
      });
    },

    /**
     * The OAuth callback that the Provider redirects to, with `params` in the
     * query. Returns its status and the redirect target.
     */
    async oauthCallback(
      provider: ProviderId,
      params: Record<string, string> = {},
    ): Promise<{ status: number; location: string | null }> {
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

export const {
  getBaseManifest,
  getManifest,
  getConfig,
  getSyncStatus,
  postConfig,
  createAccount,
  getCatalog,
  getMeta,
  refresh,
  resolveLink,
  upgrade,
  bootstrapLegacy,
} = api;
