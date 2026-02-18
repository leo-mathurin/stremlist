export type {
  Database,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "./database.types.extended.js"

export type {
  WatchlistData,
  StremioMeta,
  StremioManifest,
  StremioCatalog,
  StremioResource,
  StremioConfigOption,
} from "./stremio.types.js"

export {
  APP_NAME,
  ADDON_VERSION,
  APP_DESCRIPTION,
  APP_LOGO,
  APP_ID_PREFIX,
  SORT_OPTIONS,
  DEFAULT_SORT_OPTION,
  DEFAULT_SORT_OPTIONS,
  parseSortOption,
  CACHE_TTL_MS,
  IMDB_USER_AGENT,
  BASE_MANIFEST,
} from "./constants.js"

export type { SortField, SortOrder, SortOptions } from "./constants.js"
