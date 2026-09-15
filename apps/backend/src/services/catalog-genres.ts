import type { ConfigWatchlist } from "@stremlist/shared/stremio.types";
import { getCachedWatchlistSummary } from "./watchlist-cache";

export async function withAvailableGenres(
  watchlists: ConfigWatchlist[],
): Promise<ConfigWatchlist[]> {
  return Promise.all(
    watchlists.map(async (watchlist) => {
      const summary = await getCachedWatchlistSummary(watchlist.id);
      const genres = !summary
        ? []
        : watchlist.displayMode === "split"
          ? [...summary.movie, ...summary.series]
          : summary[watchlist.displayMode];
      return {
        ...watchlist,
        availableGenres: [...new Set(genres)].sort(),
      };
    }),
  );
}
