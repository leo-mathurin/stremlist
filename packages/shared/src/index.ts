export type {
  Database,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "./database.types.extended"

export type {
  WatchlistData,
  StremioMeta,
  StremioManifest,
  StremioCatalog,
  StremioResource,
  StremioConfigOption,
} from "./stremio.types"

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
  IMDB_USER_AGENT,
  BASE_MANIFEST,
} from "./constants"

export type { SortField, SortOrder, SortOptions } from "./constants"
