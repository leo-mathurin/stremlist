export const CATALOG_PRESETS = [
  { id: "short", label: "90 min or less" },
  { id: "rated", label: "Top rated" },
  { id: "shuffle", label: "Shuffle" },
] as const;

export type CatalogPreset = (typeof CATALOG_PRESETS)[number]["id"];

export interface CatalogSettings {
  genre?: string;
  decade?: number;
  maxRuntime?: number;
  minRating?: number;
  presets?: CatalogPreset[];
}

/** The settings that filter a Catalog (presets add Catalogs instead). */
const CATALOG_FILTER_KEYS = [
  "genre",
  "decade",
  "maxRuntime",
  "minRating",
] as const satisfies readonly (keyof CatalogSettings)[];

export type CatalogFilterKey = (typeof CATALOG_FILTER_KEYS)[number];

/** How many filters the settings set. */
export function countCatalogFilters(settings: CatalogSettings): number {
  return CATALOG_FILTER_KEYS.filter((key) => settings[key] !== undefined)
    .length;
}

const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
export const CATALOG_DECADES = Array.from(
  { length: (currentDecade - 1880) / 10 + 1 },
  (_, index) => `${currentDecade - index * 10}s`,
);
