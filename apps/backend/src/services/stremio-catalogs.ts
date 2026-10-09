import type { CatalogPreset } from "@stremlist/shared/catalog-settings";
import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type {
  ConfigList,
  ConfigListInput,
  StremioCatalog,
} from "@stremlist/shared/stremio.types";
import { CATALOG_FILTER_OPTIONS } from "./catalog-filters";
import { buildCatalogId } from "./catalog-id";

function catalogExtras(
  genres: string[],
  search = true,
): StremioCatalog["extra"] {
  return [
    { name: "skip", isRequired: false },
    ...(search ? [{ name: "search" as const, isRequired: false }] : []),
    {
      name: "genre",
      isRequired: false,
      options: [...new Set([...CATALOG_FILTER_OPTIONS, ...genres])],
      optionsLimit: 1,
    },
  ];
}

function buildCatalogName(baseTitle: string): string {
  const normalizedTitle = baseTitle.trim();
  if (!normalizedTitle) {
    return "Stremlist";
  }
  if (/^\d+$/u.test(normalizedTitle)) {
    return `Stremlist ${normalizedTitle}`;
  }
  return `Stremlist ${normalizedTitle}`;
}

function getEffectiveTitle(
  listTitle: string,
  index: number,
  total: number,
): string {
  const normalizedTitle = listTitle.trim();
  if (normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  return total <= 1 ? "" : String(index + 1);
}

/** One Catalog that a List adds to Stremio. */
export interface ListCatalog {
  type: "movie" | "series";
  /** The extra Catalog of a preset, or null for the List's main Catalog. */
  preset: CatalogPreset | null;
}

/**
 * The Catalogs of a List, in manifest order: each type that its display mode
 * shows, followed by the presets of that type.
 */
export function listCatalogs(
  list: Pick<ConfigListInput, "displayMode" | "catalogSettings">,
): ListCatalog[] {
  const types: ListCatalog["type"][] =
    list.displayMode === "movie" || list.displayMode === "series"
      ? [list.displayMode]
      : ["movie", "series"];
  const presets = CATALOG_PRESETS.filter((preset) =>
    list.catalogSettings?.presets?.includes(preset.id),
  ).map((preset) => preset.id);
  return types.flatMap((type) =>
    [null, ...presets].map((preset) => ({ type, preset })),
  );
}

export function buildManifestCatalogs(lists: ConfigList[]): StremioCatalog[] {
  return lists.flatMap((list, index) => {
    const name = buildCatalogName(
      getEffectiveTitle(list.catalogTitle, index, lists.length),
    );
    const genres = [
      ...new Set([
        ...(list.availableGenres ?? []),
        ...(list.catalogSettings?.genre ? [list.catalogSettings.genre] : []),
      ]),
    ].sort();
    return listCatalogs(list).map(({ type, preset }) => {
      const label = CATALOG_PRESETS.find((entry) => entry.id === preset)?.label;
      return {
        id: buildCatalogId(list.id, type, preset ?? undefined),
        name: label ? `${name} · ${label}` : name,
        type,
        extra: catalogExtras(genres, !preset),
      };
    });
  });
}
