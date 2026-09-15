import type { SortOptions } from "@stremlist/shared/constants";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { shuffleArray } from "../utils";

export type WatchlistSort = Omit<SortOptions, "by"> & {
  by: SortOptions["by"] | "runtime" | "released";
  then?: SortOptions;
};

export function runtimeMinutes(runtime?: string): number | null {
  const match = runtime?.match(/^(?:(\d+)h\s*)?(?:(\d+)m(?:in)?)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return minutes > 0 ? minutes : null;
}

export function sortWatchlist(
  metas: StremioMeta[],
  sort: WatchlistSort,
  generation: string,
): StremioMeta[] {
  const indices = metas.map((_, index) => index);
  const ranks: number[] = [];
  if (sort.by === "random" || sort.then?.by === "random") {
    shuffleArray([...indices], generation).forEach((index, rank) => {
      ranks[index] = rank;
    });
  }
  function compare(a: number, b: number, { by, order }: WatchlistSort): number {
    const direction = order === "desc" ? -1 : 1;
    if (by === "random") return ranks[a] - ranks[b];
    if (by === "added_at") return (a - b) * direction;
    if (by === "title")
      return metas[a].name.localeCompare(metas[b].name) * direction;
    const value = (meta: StremioMeta): number => {
      switch (by) {
        case "year":
          return Number.parseInt(meta.releaseInfo ?? "", 10) || 0;
        case "rating":
          return Number.parseFloat(meta.imdbRating ?? "") || 0;
        case "runtime":
          return runtimeMinutes(meta.runtime) ?? NaN;
        case "released":
          return Date.parse(meta.released ?? "");
      }
    };
    const left = value(metas[a]);
    const right = value(metas[b]);
    // Runtime and complete dates put missing values last in either direction.
    if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
    if (!Number.isFinite(right)) return -1;
    return (left - right) * direction;
  }
  return indices
    .sort(
      (a, b) =>
        compare(a, b, sort) || (sort.then ? compare(a, b, sort.then) : 0),
    )
    .map((index) => metas[index]);
}
