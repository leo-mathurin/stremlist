import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
  ProviderActions,
} from "../types";
import { traktGetAll, traktGetJson, traktPost } from "./api";
import type { TraktItem, TraktMedia } from "./entries";
import { imdbIdOf } from "./entries";

/** Membership is bigger than one Source list for heavy users. */
const MAX_MEMBERSHIP_ITEMS = 20_000;

interface WatchedShow extends TraktItem {
  seasons?: { number: number; episodes?: { number: number }[] | null }[] | null;
}

interface RatedItem extends TraktItem {
  rating?: number | null;
}

function watchlistIds(items: TraktItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    // Only the Title itself: a season or an episode on the watchlist does
    // not put the show on it.
    const media =
      item.type === "movie"
        ? item.movie
        : item.type === "show"
          ? item.show
          : null;
    const imdbId = imdbIdOf(media);
    if (imdbId) ids.add(imdbId);
  }
  return [...ids];
}

/** Watched movies, shows with at least one watched episode, and episodes. */
export function parseWatched(
  movies: TraktItem[],
  shows: WatchedShow[],
): Pick<Membership, "watched" | "watchedEpisodes"> {
  const watched = new Set<string>();
  const watchedEpisodes: string[] = [];
  for (const row of movies) {
    const imdbId = imdbIdOf(row.movie);
    if (imdbId) watched.add(imdbId);
  }
  for (const row of shows) {
    const imdbId = imdbIdOf(row.show);
    if (!imdbId) continue;
    let episodes = 0;
    for (const season of row.seasons ?? []) {
      for (const episode of season.episodes ?? []) {
        watchedEpisodes.push(`${imdbId}:${season.number}:${episode.number}`);
        episodes += 1;
      }
    }
    if (episodes > 0) watched.add(imdbId);
  }
  return { watched: [...watched], watchedEpisodes };
}

export function parseRatings(rows: RatedItem[]): Record<string, number> {
  const ratings: Record<string, number> = {};
  for (const row of rows) {
    const media = row.type === "show" ? row.show : (row.movie ?? row.show);
    const imdbId = imdbIdOf(media);
    if (imdbId && typeof row.rating === "number") ratings[imdbId] = row.rating;
  }
  return ratings;
}

async function getMembership(
  connection: ConnectionAccess,
): Promise<Membership> {
  const all = <T>(path: string) =>
    traktGetAll<T>(path, connection, { maxItems: MAX_MEMBERSHIP_ITEMS });
  const [watchlist, watchedMovies, watchedShows, movieRatings, showRatings] =
    await Promise.all([
      all<TraktItem>("/users/me/watchlist"),
      traktGetJson<TraktItem[]>("/sync/watched/movies", connection),
      traktGetJson<WatchedShow[]>("/sync/watched/shows", connection),
      all<RatedItem>("/sync/ratings/movies"),
      all<RatedItem>("/sync/ratings/shows"),
    ]);
  return {
    watchlist: watchlistIds(watchlist),
    ...parseWatched(watchedMovies ?? [], watchedShows ?? []),
    ratings: parseRatings([...movieRatings, ...showRatings]),
  };
}

interface SyncResponse {
  not_found?: {
    movies?: TraktMedia[];
    shows?: TraktMedia[];
    episodes?: unknown[];
  };
}

/** The /sync body for one Title, keyed by IMDb ID. */
export function syncBody(
  intent: ActionIntent,
  target: ActionTarget,
): { path: string; body: Record<string, unknown[]> } {
  const ids = { imdb: target.imdbId };
  const key = target.type === "movie" ? "movies" : "shows";
  switch (intent.kind) {
    case "watchlist":
      return {
        path: intent.add ? "/sync/watchlist" : "/sync/watchlist/remove",
        body: { [key]: [{ ids }] },
      };
    case "watched": {
      const path = intent.add ? "/sync/history" : "/sync/history/remove";
      if (target.type === "series" && target.episode) {
        return {
          path,
          body: {
            shows: [
              {
                ids,
                seasons: [
                  {
                    number: target.episode.season,
                    episodes: [{ number: target.episode.episode }],
                  },
                ],
              },
            ],
          },
        };
      }
      // A show alone marks (or unmarks) every episode.
      return { path, body: { [key]: [{ ids }] } };
    }
    case "rating":
      return intent.rating === null
        ? { path: "/sync/ratings/remove", body: { [key]: [{ ids }] } }
        : {
            path: "/sync/ratings",
            body: { [key]: [{ ids, rating: intent.rating }] },
          };
  }
}

async function perform(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
): Promise<void> {
  if (
    intent.kind === "rating" &&
    intent.rating !== null &&
    !(
      Number.isInteger(intent.rating) &&
      intent.rating >= 1 &&
      intent.rating <= 10
    )
  ) {
    throw new Error(`Invalid Trakt rating ${intent.rating}`);
  }
  const { path, body } = syncBody(intent, target);
  const result = await traktPost<SyncResponse>(path, connection, body);
  const missing = result?.not_found;
  if (
    missing &&
    ((missing.movies?.length ?? 0) > 0 ||
      (missing.shows?.length ?? 0) > 0 ||
      (missing.episodes?.length ?? 0) > 0)
  ) {
    throw new Error(`Trakt does not know ${target.imdbId}`);
  }
}

export const traktActions: ProviderActions = {
  kinds: ["watchlist", "watched", "rating"],
  getMembership,
  perform,
  affectedSources(intent) {
    switch (intent.kind) {
      case "watchlist":
        return ["me/watchlist"];
      case "watched":
        return ["me/history", "me/up-next"];
      case "rating":
        return [];
    }
  },
};
