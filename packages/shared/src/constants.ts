import type { StremioManifest } from "./stremio.types"

export const APP_NAME = "Stremlist"
export const ADDON_VERSION = "1.3.0"
export const APP_DESCRIPTION = "Your IMDb Watchlist in Stremio"
export const APP_LOGO = "https://stremlist.com/icon.png"
export const APP_ID_PREFIX = "com.stremlist"

export const SORT_OPTIONS = [
  { value: "added_at-asc", label: "Date Added (Oldest First) - (IMDb Order)" },
  { value: "added_at-desc", label: "Date Added (Newest First)" },
  { value: "random", label: "Random" },
  { value: "title-asc", label: "Title (A-Z)" },
  { value: "title-desc", label: "Title (Z-A)" },
  { value: "year-desc", label: "Newest First" },
  { value: "year-asc", label: "Oldest First" },
  { value: "rating-desc", label: "Highest Rated" },
  { value: "rating-asc", label: "Lowest Rated" },
] as const

export const DEFAULT_SORT_OPTION = "added_at-asc"

export type SortField = "added_at" | "random" | "title" | "year" | "rating"
export type SortOrder = "asc" | "desc"
export interface SortOptions {
  by: SortField
  order: SortOrder
}

export const DEFAULT_SORT_OPTIONS: SortOptions = { by: "added_at", order: "asc" }

const VALID_SORT_FIELDS: SortField[] = [
  "title",
  "year",
  "rating",
  "added_at",
  "random",
]
const VALID_SORT_ORDERS: SortOrder[] = ["asc", "desc"]

export function parseSortOption(sortOption: string | null | undefined): SortOptions {
  if (!sortOption) return DEFAULT_SORT_OPTIONS

  const [by, order] = sortOption.split("-") as [string, string]
  if (!by || !VALID_SORT_FIELDS.includes(by as SortField)) {
    return DEFAULT_SORT_OPTIONS
  }
  if (!order || !VALID_SORT_ORDERS.includes(order as SortOrder)) {
    return { by: by as SortField, order: "asc" }
  }

  return { by: by as SortField, order: order as SortOrder }
}

export const IMDB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

export const BASE_MANIFEST: StremioManifest = {
  id: APP_ID_PREFIX,
  version: ADDON_VERSION,
  name: APP_NAME,
  description: APP_DESCRIPTION,
  resources: [
    "catalog",
    {
      name: "meta",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    },
  ],
  types: ["movie", "series"],
  catalogs: [
    {
      id: "stremlist-movies",
      name: "Stremlist Movies",
      type: "movie",
    },
    {
      id: "stremlist-series",
      name: "Stremlist Series",
      type: "series",
    },
  ],
  logo: APP_LOGO,
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
  config: [
    {
      key: "sortOption",
      type: "select",
      title: "Sort Watchlist By",
      options: SORT_OPTIONS.map((o) => o.value),
      default: DEFAULT_SORT_OPTION,
    },
  ],
}
