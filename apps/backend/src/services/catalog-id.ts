import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type { CatalogPreset } from "@stremlist/shared/catalog-settings";
const CATALOG_ID_PREFIX = "wl";
const CATALOG_ID_SEPARATOR = "-";
const PREFIX_OFFSET = CATALOG_ID_PREFIX.length + CATALOG_ID_SEPARATOR.length;
const WATCHLIST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CatalogContentType = "movie" | "series";

export function buildCatalogId(
  watchlistId: string,
  type: CatalogContentType,
  preset?: CatalogPreset,
): string {
  return `${CATALOG_ID_PREFIX}${CATALOG_ID_SEPARATOR}${watchlistId}${CATALOG_ID_SEPARATOR}${type}${preset ? `--${preset}` : ""}`;
}

export function parseCatalogId(catalogId: string): {
  watchlistId: string;
  type: CatalogContentType;
  preset?: CatalogPreset;
} | null {
  const separator = catalogId.indexOf("--");
  if (separator !== -1) {
    const preset = CATALOG_PRESETS.find(
      (option) => option.id === catalogId.slice(separator + 2),
    );
    const base = parseCatalogId(catalogId.slice(0, separator));
    return preset && base ? { ...base, preset: preset.id } : null;
  }
  if (!catalogId.startsWith(`${CATALOG_ID_PREFIX}${CATALOG_ID_SEPARATOR}`)) {
    return null;
  }

  if (catalogId.endsWith(`${CATALOG_ID_SEPARATOR}movie`)) {
    const watchlistId = catalogId.slice(
      PREFIX_OFFSET,
      -(CATALOG_ID_SEPARATOR.length + "movie".length),
    );
    if (!WATCHLIST_ID_PATTERN.test(watchlistId)) {
      return null;
    }
    return { watchlistId, type: "movie" };
  }

  if (catalogId.endsWith(`${CATALOG_ID_SEPARATOR}series`)) {
    const watchlistId = catalogId.slice(
      PREFIX_OFFSET,
      -(CATALOG_ID_SEPARATOR.length + "series".length),
    );
    if (!WATCHLIST_ID_PATTERN.test(watchlistId)) {
      return null;
    }
    return { watchlistId, type: "series" };
  }

  return null;
}
