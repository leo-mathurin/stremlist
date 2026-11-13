import type { ConfigList } from "@stremlist/shared/stremio.types";
import { getCachedListSummary } from "./list-cache";
import { sourceCaches } from "./merged-lists";

/**
 * The Lists with the genres of their cached Titles: for the types that each
 * List shows (`availableGenres`, the manifest genre options) and for each of
 * its Source lists (`sourceGenres`, so the configure page can tell which
 * genres a Source list brings).
 */
export async function withAvailableGenres(
  lists: ConfigList[],
): Promise<ConfigList[]> {
  return Promise.all(
    lists.map(async (list) => {
      // A merged List offers the genres of all its Source lists.
      const summaries = await Promise.all(
        sourceCaches(list).map(({ source, cacheKey }) =>
          getCachedListSummary(cacheKey, source),
        ),
      );
      const genres = summaries.flatMap((summary) =>
        !summary
          ? []
          : list.displayMode === "split"
            ? [...summary.movie, ...summary.series]
            : summary[list.displayMode],
      );
      return {
        ...list,
        availableGenres: [...new Set(genres)].sort(),
        sourceGenres: summaries,
      };
    }),
  );
}
