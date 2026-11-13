import { z } from "zod";
import type { ActionIntent, ActionTarget } from "./types";

// The Trakt-style /sync body that Trakt, Simkl and MDBList share for
// Actions: Titles keyed by IMDb ID, in a "movies" or "shows" bucket.

/** The IDs object that names a Title. */
export interface SyncIds {
  imdb: string;
}

/** A /sync body: items by bucket ("movies" or "shows"). */
export type SyncBody = Record<string, unknown[]>;

/** A /sync write: the endpoint and its body. */
export interface SyncWrite {
  path: string;
  body: SyncBody;
}

export function syncIds(target: ActionTarget): SyncIds {
  return { imdb: target.imdbId };
}

/** Where a Title goes in a /sync body (anime and series go under "shows"). */
export function bucketOf(target: ActionTarget): "movies" | "shows" {
  return target.type === "movie" ? "movies" : "shows";
}

/** A show item that names some of its episodes, dated by `watchedAt`. */
export function episodeItem(
  target: ActionTarget,
  episodes: { season: number; episode: number }[],
  watchedAt?: string,
) {
  const seasons = [...new Set(episodes.map((e) => e.season))];
  return {
    ids: syncIds(target),
    seasons: seasons.map((season) => ({
      number: season,
      episodes: episodes
        .filter((e) => e.season === season)
        .map((e) => ({
          number: e.episode,
          ...(watchedAt ? { watched_at: watchedAt } : {}),
        })),
    })),
  };
}

/** The date of a play, for a /sync write that adds one. */
export function watchedAtOf(intent: ActionIntent): { watched_at?: string } {
  return intent.kind === "watched" && intent.add && intent.watchedAt
    ? { watched_at: intent.watchedAt }
    : {};
}

const notFoundSchema = z.object({
  not_found: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
});

/**
 * How many items of a /sync answer the Provider did not know: the sum of
 * the `not_found` counts (numbers, or arrays of items) under `keys`, or under
 * every key when `keys` is not given.
 */
export function countNotFound(
  result: unknown,
  keys?: readonly string[],
): number {
  const parsed = notFoundSchema.safeParse(result);
  if (!parsed.success) return 0;
  const byKey = new Map(Object.entries(parsed.data.not_found));
  return (keys ?? [...byKey.keys()]).reduce((sum, key) => {
    const value = byKey.get(key);
    if (typeof value === "number") return sum + value;
    if (Array.isArray(value)) return sum + value.length;
    return sum;
  }, 0);
}
