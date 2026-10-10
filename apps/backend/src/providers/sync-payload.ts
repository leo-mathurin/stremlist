import type { ActionTarget } from "./types";

/**
 * The Trakt-style /sync body that Trakt, Simkl and MDBList share for
 * Actions: Titles keyed by IMDb ID, in a "movies" or "shows" bucket.
 */
type SyncBucket = "movies" | "shows";

/** The IDs object that names a Title. */
export function syncIds(target: ActionTarget): { imdb: string } {
  return { imdb: target.imdbId };
}

/** Where a Title goes in a /sync body (anime and series go under "shows"). */
export function bucketOf(target: ActionTarget): SyncBucket {
  return target.type === "movie" ? "movies" : "shows";
}

/** A show item that names one of its episodes. */
export function episodeItem(
  target: ActionTarget,
  episode: { season: number; episode: number },
): {
  ids: { imdb: string };
  seasons: { number: number; episodes: { number: number }[] }[];
} {
  return {
    ids: syncIds(target),
    seasons: [
      { number: episode.season, episodes: [{ number: episode.episode }] },
    ],
  };
}

/**
 * How many items of a /sync answer the Provider did not know: the sum of
 * the `not_found` counts (numbers, or arrays of items) under `keys`, or under
 * every key when `keys` is not given.
 */
export function countNotFound(
  result: unknown,
  keys?: readonly string[],
): number {
  const notFound = (result as { not_found?: unknown } | null)?.not_found;
  if (!notFound || typeof notFound !== "object") return 0;
  const byKey = notFound as Record<string, unknown>;
  return (keys ?? Object.keys(byKey)).reduce((sum, key) => {
    const value = byKey[key];
    if (typeof value === "number") return sum + value;
    if (Array.isArray(value)) return sum + value.length;
    return sum;
  }, 0);
}
