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
) {
  return `${CATALOG_ID_PREFIX}${CATALOG_ID_SEPARATOR}${listId}${CATALOG_ID_SEPARATOR}${type}${preset ? `--${preset}` : ""}`;
}

interface ListCatalogId {
  listId: string;
  type: TitleType;
  preset?: CatalogPreset;
}

type ParsedCatalogId =
  | ({ kind: "list" } & ListCatalogId)
  | { kind: "new-titles"; type: TitleType; preset?: CatalogPreset };

function parseListCatalogId(catalogId: string) {
  const separator = catalogId.indexOf("--");
  if (separator === -1) {
    const parsed: ListCatalogId | null = parseBaseListCatalogId(catalogId);
    return parsed;
  }
  const preset = CATALOG_PRESETS.find(
    (option) => option.id === catalogId.slice(separator + 2),
  );
  const base = parseBaseListCatalogId(catalogId.slice(0, separator));
  return preset && base
    ? ({ ...base, preset: preset.id } satisfies ListCatalogId)
    : null;
}

function parseBaseListCatalogId(catalogId: string) {
  if (!catalogId.startsWith(`${CATALOG_ID_PREFIX}${CATALOG_ID_SEPARATOR}`)) {
    return null;
  }

  for (const type of ["movie", "series"] as const) {
    if (catalogId.endsWith(`${CATALOG_ID_SEPARATOR}${type}`)) {
      const listId = catalogId.slice(
        PREFIX_OFFSET,
        -(CATALOG_ID_SEPARATOR.length + type.length),
      );
      return LIST_ID_PATTERN.test(listId) ? { listId, type } : null;
    }
  }
  return null;
}

const NEW_TITLES_PREFIX = "new-titles-";

export function buildNewTitlesCatalogId(
  type: TitleType,
  preset?: CatalogPreset,
) {
  return `${NEW_TITLES_PREFIX}${type}${preset ? `--${preset}` : ""}`;
}

export function parseCatalogId(catalogId: string) {
  if (catalogId.startsWith(NEW_TITLES_PREFIX)) {
    const [type, suffix, ...rest] = catalogId
      .slice(NEW_TITLES_PREFIX.length)
      .split("--");
    if ((type !== "movie" && type !== "series") || rest.length > 0) return null;
    const preset = CATALOG_PRESETS.find((option) => option.id === suffix)?.id;
    if (suffix !== undefined && !preset) return null;
    return { kind: "new-titles", type, preset } satisfies ParsedCatalogId;
  }
  const list = parseListCatalogId(catalogId);
  return list && ({ kind: "list", ...list } satisfies ParsedCatalogId);
}
