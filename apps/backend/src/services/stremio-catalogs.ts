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

const CATALOG_EXTRA: StremioCatalog["extra"] = [
  { name: "skip", isRequired: false },
];
const CATALOG_EXTRA_SUPPORTED: StremioCatalog["extraSupported"] = ["skip"];

export function buildManifestCatalogs(
  watchlists: ConfigWatchlist[],
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
        name: buildCatalogName(effectiveTitle),
        type: "movie",
        extra: CATALOG_EXTRA,
        extraSupported: CATALOG_EXTRA_SUPPORTED,
      },
      {
        id: buildCatalogId(watchlist.id, "series"),
        name: buildCatalogName(effectiveTitle),
        type: "series",
        extra: CATALOG_EXTRA,
        extraSupported: CATALOG_EXTRA_SUPPORTED,
      },
    ];
  });
}
