import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type { CatalogPreset } from "@stremlist/shared/catalog-settings";
import type { TitleType } from "@stremlist/shared/constants";
const CATALOG_ID_PREFIX = "wl";
const CATALOG_ID_SEPARATOR = "-";
const PREFIX_OFFSET = CATALOG_ID_PREFIX.length + CATALOG_ID_SEPARATOR.length;
const LIST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildCatalogId(
  listId: string,
  type: TitleType,
  preset?: CatalogPreset,
): string {
  return `${CATALOG_ID_PREFIX}${CATALOG_ID_SEPARATOR}${listId}${CATALOG_ID_SEPARATOR}${type}${preset ? `--${preset}` : ""}`;
}

interface ListCatalogId {
  listId: string;
  type: TitleType;
  preset?: CatalogPreset;
}

/** A catalog of the manifest: one of a List, or a "New titles" one. */
type ParsedCatalogId =
  | ({ kind: "list" } & ListCatalogId)
  | { kind: "new-titles"; type: TitleType };

function parseListCatalogId(catalogId: string): ListCatalogId | null {
  const separator = catalogId.indexOf("--");
  if (separator !== -1) {
    const preset = CATALOG_PRESETS.find(
      (option) => option.id === catalogId.slice(separator + 2),
    );
    const base = parseListCatalogId(catalogId.slice(0, separator));
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

/** The "New titles" catalogs, one per type (ADR 0007). */
const NEW_TITLES_PREFIX = "new-titles-";

export function buildNewTitlesCatalogId(type: TitleType): string {
  return `${NEW_TITLES_PREFIX}${type}`;
}

export function parseCatalogId(catalogId: string): ParsedCatalogId | null {
  if (catalogId.startsWith(NEW_TITLES_PREFIX)) {
    const type = catalogId.slice(NEW_TITLES_PREFIX.length);
    return type === "movie" || type === "series"
      ? { kind: "new-titles", type }
      : null;
  }
  const list = parseListCatalogId(catalogId);
  return list && { kind: "list", ...list };
}
