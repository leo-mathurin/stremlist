import type { CatalogSettings } from "./catalog-settings";
import type { DisplayMode } from "./constants";
import type { ListSource } from "./list-merge";
import type { ProviderId } from "./providers";
import type { ListSyncStatus, ListSyncStatuses } from "./sync-status";

export interface CatalogData {
  metas: StremioMeta[];
}

/** Genres of Titles, by Title type. */
export interface TitleGenres {
  movie: string[];
  series: string[];
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
  /**
   * The genres of each Source list's cached Titles, by type, in the order of
   * `listSources`; null when nothing is cached for it yet.
   */
  sourceGenres?: (TitleGenres | null)[];
  catalogSettings?: CatalogSettings;
  /**
   * More Source lists merged into this List after `provider`/`sourceRef`.
   * Absent for a List with one Source list.
   */
  mergedSources?: ListSource[];
  /** The label of the first Source list (see `ListSource.label`). */
  sourceLabel?: string;
}

export interface ConnectionSummary {
  provider: ProviderId;
  username: string | null;
  connectedAt: string;
  /** Since when the Provider refuses this Connection, or null. */
  needsRenewalSince: string | null;
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

/**
 * The sync status of an Account's Lists and its Connections. The configure
 * page gets it with the config, after "Refresh now" and from its polls.
 */
export interface AccountSyncSnapshot {
  /** Sync status of the first Source list of each List, by List ID. */
  syncStatus: ListSyncStatuses;
  /**
   * Sync status of the other Source lists of merged Lists, by List ID; a
   * Source list that was never read has none. Absent from older backends.
   */
  sourceSyncStatus?: Record<string, ListSyncStatus[]>;
  connections: ConnectionSummary[];
}

export interface AccountConfigResponse extends AccountSyncSnapshot {
  access: AddonAccess;
  /** The Account ID; only returned for private access. */
  accountId: string | null;
  /** Legacy alias accounts: when a private copy was made from this install. */
  movedAt: string | null;
  rpdbApiKey: string | null;
  lists: ConfigList[];
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
  mergedSources?: ListSource[];
  sourceLabel?: string;
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
