import type { ConfigWatchlist, StremioCatalog } from "@stremlist/shared";
import { buildCatalogId } from "./catalog-id";

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

    const movieCatalog: StremioCatalog = {
      id: buildCatalogId(watchlist.id, "movie"),
      name: buildCatalogName(effectiveTitle),
      type: "movie",
    };
    const seriesCatalog: StremioCatalog = {
      id: buildCatalogId(watchlist.id, "series"),
      name: buildCatalogName(effectiveTitle),
      type: "series",
    };

    if (displayMode === "movie") {
      return [movieCatalog];
    }
    if (displayMode === "series") {
      return [seriesCatalog];
    }
    return [movieCatalog, seriesCatalog];
  });
}
