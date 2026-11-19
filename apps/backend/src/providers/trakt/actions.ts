import { z } from "zod";
import {
  bucketOf,
  countNotFound,
  episodeItem,
  syncIds,
  watchedAtOf,
} from "../sync-payload";
import type { SyncWrite } from "../sync-payload";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
  ProviderActions,
} from "../types";
import { targetEpisodes, UnknownTitleError } from "../types";
import { traktGetAll, traktPost } from "./api";
import type { TraktItem } from "./entries";
import { imdbIdOf, traktItemSchema } from "./entries";

const MAX_MEMBERSHIP_ITEMS = 20_000;

const watchedShowSchema = traktItemSchema.extend({
  seasons: z
    .array(
      z.object({
        number: z.number(),
        episodes: z.array(z.object({ number: z.number() })).nullish(),
      }),
    )
    .nullish(),
});
type WatchedShow = z.infer<typeof watchedShowSchema>;

const ratedItemSchema = traktItemSchema.extend({
  rating: z.number().nullish(),
});
type RatedItem = z.infer<typeof ratedItemSchema>;

function watchlistIds(items: TraktItem[]) {
  const ids = new Set<string>();
  for (const item of items) {
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

function parseWatched(movies: TraktItem[], shows: WatchedShow[]) {
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

function parseRatings(rows: RatedItem[]) {
  const ratings: Membership["ratings"] = {};
  for (const row of rows) {
    const media = row.type === "show" ? row.show : (row.movie ?? row.show);
    const imdbId = imdbIdOf(media);
    if (imdbId && typeof row.rating === "number") ratings[imdbId] = row.rating;
  }
  return ratings;
}

async function getMembership(connection: ConnectionAccess) {
  const all = async <T>(path: string, schema: z.ZodType<T>) =>
    (
      await traktGetAll(path, schema, connection, {
        maxItems: MAX_MEMBERSHIP_ITEMS,
      })
    ).items;
  const [watchlist, watchedMovies, watchedShows, movieRatings, showRatings] =
    await Promise.all([
      all("/users/me/watchlist", traktItemSchema),
      all("/sync/watched/movies", traktItemSchema),
      all("/sync/watched/shows", watchedShowSchema),
      all("/sync/ratings/movies", ratedItemSchema),
      all("/sync/ratings/shows", ratedItemSchema),
    ]);
  return {
    watchlist: watchlistIds(watchlist),
    ...parseWatched(watchedMovies, watchedShows),
    ratings: parseRatings([...movieRatings, ...showRatings]),
  };
}

function syncBody(intent: ActionIntent, target: ActionTarget) {
  const ids = syncIds(target);
  const key = bucketOf(target);
  switch (intent.kind) {
    case "watchlist":
      return {
        path: intent.add ? "/sync/watchlist" : "/sync/watchlist/remove",
        body: { [key]: [{ ids }] },
      } satisfies SyncWrite;
    case "watched": {
      const path = intent.add ? "/sync/history" : "/sync/history/remove";
      const at = watchedAtOf(intent);
      const episodes = targetEpisodes(target);
      if (target.type === "series" && episodes.length > 0) {
        return {
          path,
          body: { shows: [episodeItem(target, episodes, at.watched_at)] },
        } satisfies SyncWrite;
      }
      return { path, body: { [key]: [{ ids, ...at }] } } satisfies SyncWrite;
    }
    case "rating":
      return intent.rating === null
        ? ({
            path: "/sync/ratings/remove",
            body: { [key]: [{ ids }] },
          } satisfies SyncWrite)
        : ({
            path: "/sync/ratings",
            body: { [key]: [{ ids, rating: intent.rating }] },
          } satisfies SyncWrite);
  }
}

async function perform(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
) {
  const { path, body } = syncBody(intent, target);
  const result = await traktPost(path, connection, body);
  if (countNotFound(result, ["movies", "shows", "episodes"]) > 0) {
    throw new UnknownTitleError("trakt", target.imdbId);
  }
}

const historyMediaSchema = z.object({
  ids: z.object({ imdb: z.string().nullish() }).optional(),
});

const historyRowSchema = z.object({
  watched_at: z.string().optional(),
  movie: historyMediaSchema.optional(),
  show: historyMediaSchema.optional(),
  episode: z
    .object({ season: z.number().optional(), number: z.number().optional() })
    .optional(),
});

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
) {
  const at = Date.parse(watchedAt);
  const kind = target.type === "movie" ? "movies" : "episodes";
  const { items: rows } = await traktGetAll(
    `/sync/history/${kind}`,
    historyRowSchema,
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
        return ["me/ratings"];
    }
  },
};
