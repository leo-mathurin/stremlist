import type { ConfigList } from "@stremlist/shared/stremio.types";
import { getCachedListSummary } from "./list-cache";
import { sourceCaches } from "./merged-lists";

export async function withAvailableGenres(
  lists: ConfigList[],
): Promise<ConfigList[]> {
  return Promise.all(
    lists.map(async (list) => {
      // A merged List offers the genres of all its Source lists.
      const summaries = await Promise.all(
        sourceCaches(list).map(({ cacheKey }) =>
          getCachedListSummary(cacheKey),
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
      };
    }),
  );
}
