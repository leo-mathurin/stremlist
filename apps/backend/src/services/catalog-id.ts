import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type { CatalogPreset } from "@stremlist/shared/catalog-settings";
const CATALOG_ID_PREFIX = "wl";
const CATALOG_ID_SEPARATOR = "-";
const PREFIX_OFFSET = CATALOG_ID_PREFIX.length + CATALOG_ID_SEPARATOR.length;
const LIST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CatalogContentType = "movie" | "series";

export function buildCatalogId(
  listId: string,
  type: CatalogContentType,
  preset?: CatalogPreset,
): string {
  return `${CATALOG_ID_PREFIX}${CATALOG_ID_SEPARATOR}${listId}${CATALOG_ID_SEPARATOR}${type}${preset ? `--${preset}` : ""}`;
}

export function parseCatalogId(catalogId: string): {
  listId: string;
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
    const listId = catalogId.slice(
      PREFIX_OFFSET,
      -(CATALOG_ID_SEPARATOR.length + "movie".length),
    );
    if (!LIST_ID_PATTERN.test(listId)) {
      return null;
    }
    return { listId, type: "movie" };
  }

  if (catalogId.endsWith(`${CATALOG_ID_SEPARATOR}series`)) {
    const listId = catalogId.slice(
      PREFIX_OFFSET,
      -(CATALOG_ID_SEPARATOR.length + "series".length),
    );
    if (!LIST_ID_PATTERN.test(listId)) {
      return null;
    }
    return { listId, type: "series" };
  }

  return null;
}

/** The "New titles" catalogs, one per type (ADR 0004). */
const NEW_TITLES_PREFIX = "new-titles-";

export function buildNewTitlesCatalogId(type: CatalogContentType): string {
  return `${NEW_TITLES_PREFIX}${type}`;
}

export function parseNewTitlesCatalogId(
  catalogId: string,
): CatalogContentType | null {
  if (!catalogId.startsWith(NEW_TITLES_PREFIX)) return null;
  const type = catalogId.slice(NEW_TITLES_PREFIX.length);
  return type === "movie" || type === "series" ? type : null;
}
