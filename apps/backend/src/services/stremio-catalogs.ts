import type { StremioCatalog } from "@stremlist/shared";
import { buildCatalogId } from "./catalog-id";

interface ManifestWatchlist {
  id: string;
  catalogTitle: string;
  imdbUserId?: string;
  sortOption?: string;
  position?: number;
}

function buildCatalogName(baseTitle: string, type: "movie" | "series"): string {
  const suffix = type === "movie" ? "Movies" : "Series";
  const normalizedTitle = baseTitle.trim();
  if (!normalizedTitle) {
    return `Stremlist - ${suffix}`;
  }
  if (/^\d+$/u.test(normalizedTitle)) {
    return `Stremlist ${normalizedTitle} - ${suffix}`;
  }
  return `Stremlist - ${normalizedTitle} ${suffix}`;
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
  watchlists: ManifestWatchlist[],
): StremioCatalog[] {
  return watchlists.flatMap((watchlist, index) => {
    const effectiveTitle = getEffectiveTitle(
      watchlist.catalogTitle,
      index,
      watchlists.length,
    );
    return [
      {
        id: buildCatalogId(watchlist.id, "movie"),
        name: buildCatalogName(effectiveTitle, "movie"),
        type: "movie",
      },
      {
        id: buildCatalogId(watchlist.id, "series"),
        name: buildCatalogName(effectiveTitle, "series"),
        type: "series",
      },
    ];
  });
}
