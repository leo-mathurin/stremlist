import type { ConfigWatchlist } from "@stremlist/shared";
import { getWatchlistByConfig } from "./watchlist";

export async function prewarmWatchlists(
  ownerUserId: string,
  watchlists: ConfigWatchlist[],
): Promise<void> {
  const startedAt = performance.now();
  const results = await Promise.allSettled(
    watchlists.map((watchlist) =>
      getWatchlistByConfig({
        ownerUserId,
        watchlistId: watchlist.id,
        imdbUserId: watchlist.imdbUserId,
        sortOption: watchlist.sortOption,
        // Prewarming only needs the canonical cache. Poster customization is
        // applied later when Stremio requests the catalog.
        rpdbApiKey: null,
        skipUserTimestamp: true,
      }),
    ),
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `Failed to prewarm watchlist ${watchlists[index].id}:`,
        result.reason,
      );
    }
  });

  const prewarmed = results.filter(
    (result) => result.status === "fulfilled",
  ).length;
  console.log(
    `Prewarmed ${prewarmed}/${watchlists.length} watchlists in ${Math.round(performance.now() - startedAt)}ms`,
  );
}
