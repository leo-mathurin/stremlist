import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type {
  ConfigWatchlist,
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
  watchlistTitle: string,
  index: number,
  total: number,
): string {
  const normalizedTitle = watchlistTitle.trim();
  if (normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  return total <= 1 ? "" : String(index + 1);
}

export function buildManifestCatalogs(
  watchlists: ConfigWatchlist[],
): StremioCatalog[] {
  return watchlists.flatMap((watchlist, index) => {
    const effectiveTitle = getEffectiveTitle(
      watchlist.catalogTitle,
      index,
      watchlists.length,
    );
    const displayMode =
      watchlist.displayMode === "movie" || watchlist.displayMode === "series"
        ? watchlist.displayMode
        : "split";

    const genres = [
      ...new Set([
        ...(watchlist.availableGenres ?? []),
        ...(watchlist.catalogSettings?.genre
          ? [watchlist.catalogSettings.genre]
          : []),
      ]),
    ].sort();
    const movieCatalog: StremioCatalog = {
      id: buildCatalogId(watchlist.id, "movie"),
      name: buildCatalogName(effectiveTitle),
      type: "movie",
      extra: catalogExtras(genres),
    };
    const seriesCatalog: StremioCatalog = {
      id: buildCatalogId(watchlist.id, "series"),
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
        watchlist.catalogSettings?.presets?.includes(preset.id),
      ).map((preset) => ({
        ...catalog,
        id: buildCatalogId(watchlist.id, catalog.type, preset.id),
        name: `${catalog.name} · ${preset.label}`,
        extra: catalogExtras(genres, false),
      })),
    ]);
  });
}
