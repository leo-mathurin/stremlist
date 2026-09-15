import type { ConfigWatchlist } from "@stremlist/shared/stremio.types";
import { getCachedWatchlist } from "./watchlist-cache";

export async function withAvailableGenres(
  watchlists: ConfigWatchlist[],
): Promise<ConfigWatchlist[]> {
  return Promise.all(
    watchlists.map(async (watchlist) => {
      const cached = await getCachedWatchlist(watchlist.id);
      const genres = (cached?.data.metas ?? [])
        .filter(
          (meta) =>
            watchlist.displayMode === "split" ||
            meta.type === watchlist.displayMode,
        )
        .flatMap((meta) => meta.genres);
      return {
        ...watchlist,
        availableGenres: [
          ...new Set(genres.filter((genre) => genre.trim().length > 0)),
        ].sort(),
      };
    }),
  );
}
