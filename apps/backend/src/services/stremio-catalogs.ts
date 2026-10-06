import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type {
  ConfigList,
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

export function buildManifestCatalogs(lists: ConfigList[]): StremioCatalog[] {
  return lists.flatMap((list, index) => {
    const effectiveTitle = getEffectiveTitle(
      list.catalogTitle,
      index,
      lists.length,
    );
    const displayMode =
      list.displayMode === "movie" || list.displayMode === "series"
        ? list.displayMode
        : "split";

    const genres = [
      ...new Set([
        ...(list.availableGenres ?? []),
        ...(list.catalogSettings?.genre ? [list.catalogSettings.genre] : []),
      ]),
    ].sort();
    const movieCatalog: StremioCatalog = {
      id: buildCatalogId(list.id, "movie"),
      name: buildCatalogName(effectiveTitle),
      type: "movie",
      extra: catalogExtras(genres),
    };
    const seriesCatalog: StremioCatalog = {
      id: buildCatalogId(list.id, "series"),
      name: buildCatalogName(effectiveTitle),
      type: "series",
      extra: catalogExtras(genres),
    };

    const base =
      displayMode === "movie"
        ? [movieCatalog]
        : displayMode === "series"
          ? [seriesCatalog]
          : [movieCatalog, seriesCatalog];
    return base.flatMap((catalog) => [
      catalog,
      ...CATALOG_PRESETS.filter((preset) =>
        list.catalogSettings?.presets?.includes(preset.id),
      ).map((preset) => ({
        ...catalog,
        id: buildCatalogId(list.id, catalog.type, preset.id),
        name: `${catalog.name} · ${preset.label}`,
        extra: catalogExtras(genres, false),
      })),
    ]);
  });
}
