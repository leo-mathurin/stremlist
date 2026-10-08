import type { CatalogSettings } from "./catalog-settings";
import type { DisplayMode } from "./constants";
import type { ProviderId } from "./providers";

export interface CatalogData {
  metas: StremioMeta[];
}

/** One List of an Account, as the configure page and the API see it. */
export interface ConfigList {
  id: string;
  provider: ProviderId;
  sourceRef: string;
  catalogTitle: string;
  sortOption: string;
  displayMode: DisplayMode;
  position: number;
  availableGenres?: string[];
  catalogSettings?: CatalogSettings;
}

export interface ConnectionSummary {
  provider: ProviderId;
  username: string | null;
  connectedAt: string;
}

/**
 * How an Addon URL reaches its Account: "private" through the Account ID,
 * "legacy" through a Legacy alias (`ur…`), which anyone can guess (ADR 0001).
 */
export type AddonAccess = "private" | "legacy";

/** The state of the "New titles" catalog of an Account (ADR 0007). */
export interface NewTitlesSummary {
  /** Detected Titles that the Lists still contain, one per Title. */
  detected: number;
  /** The most recent detection, or null before the first one. */
  latestDetectedAt: string | null;
  /** Lists without a Baseline yet: every read failed or was cut short. */
  waitingLists: number;
}

export interface AccountConfigResponse {
  access: AddonAccess;
  /** The Account ID; only returned for private access. */
  accountId: string | null;
  /** Legacy alias accounts: when a private copy was made from this install. */
  movedAt: string | null;
  rpdbApiKey: string | null;
  lists: ConfigList[];
  connections: ConnectionSummary[];
  actions: { enabled: boolean; providers: ProviderId[] };
  newTitles: {
    enabled: boolean;
    /** Null when the detection history cannot be read right now. */
    summary: NewTitlesSummary | null;
  };
  lastFetchedAt: string;
  cooldownSeconds: number;
}

export interface ConfigListInput {
  id?: string;
  provider: ProviderId;
  sourceRef: string;
  catalogTitle?: string;
  sortOption: string;
  displayMode?: DisplayMode;
  position?: number;
  catalogSettings?: CatalogSettings;
}

export interface AccountConfigInput {
  rpdbApiKey?: string;
  lists: ConfigListInput[];
  actions?: { enabled: boolean; providers: ProviderId[] };
  newTitles?: { enabled: boolean };
}

export interface StremioMeta {
  id: string;
  name: string;
  poster: string | null;
  posterShape: "poster" | "square" | "landscape";
  type: "movie" | "series";
  genres: string[];
  description: string;
  imdbRating?: string;
  releaseInfo?: string;
  director?: string[];
  cast?: string[];
  runtime?: string;
  released?: string;
}

export interface StremioCatalog {
  id: string;
  name: string;
  type: "movie" | "series";
  extra?: {
    name: "skip" | "genre" | "search";
    isRequired?: boolean;
    options?: string[];
    optionsLimit?: number;
  }[];
}

export interface StremioResource {
  name: string;
  types: string[];
  idPrefixes?: string[];
}

export interface StremioConfigOption {
  key: string;
  type: "select" | "text" | "password" | "checkbox";
  title: string;
  options?: string[];
  default?: string;
}

export interface StremioStream {
  name: string;
  title?: string;
  description?: string;
  externalUrl?: string;
  url?: string;
  behaviorHints?: { notWebReady?: boolean; bingeGroup?: string };
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: (string | StremioResource)[];
  types: string[];
  catalogs: StremioCatalog[];
  logo: string;
  behaviorHints: {
    configurable: boolean;
    configurationRequired: boolean;
  };
  config?: StremioConfigOption[];
  selfUrl?: string;
}
