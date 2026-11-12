import {
  bucketOf,
  countNotFound,
  episodeItem,
  syncIds,
  watchedAtOf,
} from "../sync-payload";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
  ProviderActions,
} from "../types";
import { targetEpisodes, UnknownTitleError } from "../types";
import { traktGetAll, traktGetJson, traktPost } from "./api";
import type { TraktItem } from "./entries";
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
function parseWatched(
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

function parseRatings(rows: RatedItem[]): Record<string, number> {
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
  const all = async <T>(path: string) =>
    (await traktGetAll<T>(path, connection, { maxItems: MAX_MEMBERSHIP_ITEMS }))
      .items;
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

/** The /sync body for one Title, keyed by IMDb ID. */
function syncBody(
  intent: ActionIntent,
  target: ActionTarget,
): { path: string; body: Record<string, unknown[]> } {
  const ids = syncIds(target);
  const key = bucketOf(target);
  switch (intent.kind) {
    case "watchlist":
      return {
        path: intent.add ? "/sync/watchlist" : "/sync/watchlist/remove",
        body: { [key]: [{ ids }] },
      };
    case "watched": {
      const path = intent.add ? "/sync/history" : "/sync/history/remove";
      const at = watchedAtOf(intent);
      const episodes = targetEpisodes(target);
      if (target.type === "series" && episodes.length > 0) {
        return {
          path,
          body: { shows: [episodeItem(target, episodes, at.watched_at)] },
        };
      }
      // A show alone marks (or unmarks) every episode.
      return { path, body: { [key]: [{ ids, ...at }] } };
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
  const { path, body } = syncBody(intent, target);
  const result = await traktPost<unknown>(path, connection, body);
  if (countNotFound(result, ["movies", "shows", "episodes"]) > 0) {
    throw new UnknownTitleError("trakt", target.imdbId);
  }
}

interface HistoryRow {
  watched_at?: string;
  movie?: { ids?: { imdb?: string | null } };
  show?: { ids?: { imdb?: string | null } };
  episode?: { season?: number; number?: number };
}

/**
 * What of `target` Trakt's history has at `watchedAt` (within a minute):
 * "movie" for the movie, "season:episode" for each episode. Watch tracking
 * asks before it sends a play again after a write whose answer never came:
 * Trakt adds a play for every write.
 */
export async function traktPlays(
  connection: ConnectionAccess,
  target: ActionTarget,
  watchedAt: string,
): Promise<Set<string>> {
  const at = Date.parse(watchedAt);
  const kind = target.type === "movie" ? "movies" : "episodes";
  // A whole series marked at once shares one time: read every page.
  const { items: rows } = await traktGetAll<HistoryRow>(
    `/sync/history/${kind}`,
    connection,
    {
      query: {
        start_at: new Date(at - 60_000).toISOString(),
        end_at: new Date(at + 60_000).toISOString(),
      },
      maxItems: 5000,
    },
  );
  return new Set(
    rows.flatMap((row) => {
      if (target.type === "movie") {
        return row.movie?.ids?.imdb === target.imdbId ? ["movie"] : [];
      }
      return row.show?.ids?.imdb === target.imdbId && row.episode
        ? [`${row.episode.season}:${row.episode.number}`]
        : [];
    }),
  );
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
