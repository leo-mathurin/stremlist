import type { ConfigList } from "@stremlist/shared/stremio.types";
import { getCachedListSummary } from "./list-cache";

export async function withAvailableGenres(
  lists: ConfigList[],
): Promise<ConfigList[]> {
  return Promise.all(
    lists.map(async (list) => {
      const summary = await getCachedListSummary(list.id);
      const genres = !summary
        ? []
        : list.displayMode === "split"
          ? [...summary.movie, ...summary.series]
          : summary[list.displayMode];
      return {
        ...list,
        availableGenres: [...new Set(genres)].sort(),
      };
    }),
  );
}
