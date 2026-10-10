import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
  ProviderActions,
} from "../types";
import { connectionToken } from "../types";
import { simklRequest } from "./api";
import { LIBRARY_REFS, titleType } from "./entries";
import type { LibraryItem } from "./library";
import { knownItems, markLibraryChanged, syncLibrary } from "./library";

interface WriteResult {
  not_found?: Record<string, unknown[] | undefined>;
}

export function membershipFrom(items: LibraryItem[]): Membership {
  const watchlist = new Set<string>();
  const watched = new Set<string>();
  const watchedEpisodes = new Set<string>();
  const ratings: Record<string, number> = {};
  for (const item of items) {
    if (!item.imdb) continue;
    if (item.status === "plantowatch") watchlist.add(item.imdb);
    if (titleType(item.kind, item.animeType) === "movie") {
      if (item.status === "completed") watched.add(item.imdb);
    } else {
      const episodes = item.episodes ?? [];
      if (
        item.status === "completed" ||
        item.watchedEpisodes > 0 ||
        episodes.length > 0
      ) {
        watched.add(item.imdb);
      }
      for (const episode of episodes)
        watchedEpisodes.add(`${item.imdb}:${episode}`);
    }
    if (item.rating) ratings[item.imdb] = item.rating;
  }
  return {
    watchlist: [...watchlist],
    watched: [...watched],
    watchedEpisodes: [...watchedEpisodes],
    ratings,
  };
}

interface WriteRequest {
  path: string;
  item: Record<string, unknown>;
}

async function buildWrite(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
): Promise<WriteRequest | null> {
  const item: Record<string, unknown> = { ids: { imdb: target.imdbId } };
  const series = target.type === "series";

  if (intent.kind === "watchlist") {
    if (intent.add)
      return {
        path: "/sync/add-to-list",
        item: { ...item, to: "plantowatch" },
      };
    // Removing a title from Simkl also deletes its watch history and rating,
    // so only remove titles that are planned, not ones the user watched.
    const known = await knownItems(connection.accountId, target.imdbId);
    if (known.some((entry) => entry.status !== "plantowatch")) return null;
    return { path: "/sync/history/remove", item };
  }

  if (intent.kind === "watched") {
    const path = intent.add ? "/sync/history" : "/sync/history/remove";
    if (series && target.episode) {
      return {
        path,
        item: {
          ...item,
          // Stremio uses IMDb seasons; this maps them onto Simkl's anime
          // entries and is a no-op for other shows.
          use_tvdb_anime_seasons: true,
          seasons: [
            {
              number: target.episode.season,
              episodes: [{ number: target.episode.episode }],
            },
          ],
        },
      };
    }
    if (intent.add) {
      return { path, item: series ? { ...item, status: "completed" } : item };
    }
    if (series) {
      // Unmark the watched seasons and keep the show in the library. Without
      // known episodes, fall back to removing the show, as Simkl's own
      // "Remove from list" does.
      const seasons = new Set<number>();
      for (const known of await knownItems(
        connection.accountId,
        target.imdbId,
      )) {
        for (const episode of known.episodes ?? [])
          seasons.add(Number(episode.split(":")[0]));
      }
      if (seasons.size > 0) {
        return {
          path,
          item: {
            ...item,
            use_tvdb_anime_seasons: true,
            seasons: [...seasons]
              .sort((a, b) => a - b)
              .map((number) => ({ number })),
          },
        };
      }
    }
    return { path, item };
  }

  if (intent.rating === null) return { path: "/sync/ratings/remove", item };
  if (
    !Number.isInteger(intent.rating) ||
    intent.rating < 1 ||
    intent.rating > 10
  ) {
    throw new Error(`Simkl ratings go from 1 to 10, got ${intent.rating}`);
  }
  return { path: "/sync/ratings", item: { ...item, rating: intent.rating } };
}

async function perform(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
): Promise<void> {
  const write = await buildWrite(connection, intent, target);
  if (!write) return;
  const token = await connectionToken(connection);
  // Anime go under "shows" on every Simkl write endpoint.
  const bucket = target.type === "movie" ? "movies" : "shows";
  const result = await simklRequest<WriteResult>(write.path, {
    method: "POST",
    token,
    body: { [bucket]: [write.item] },
  });
  const notFound = Object.values(result.not_found ?? {}).some(
    (values) => Array.isArray(values) && values.length > 0,
  );
  if (notFound) throw new Error(`Simkl does not know ${target.imdbId}`);
  await markLibraryChanged(connection.accountId);
}

export const simklActions: ProviderActions = {
  kinds: ["watchlist", "watched", "rating"],

  async getMembership(connection) {
    return membershipFrom((await syncLibrary(connection)).items);
  },

  perform,

  // A Simkl title sits in exactly one status, so adding, watching or rating
  // it (rating files an unlisted title) can move it between all of them.
  affectedSources() {
    return LIBRARY_REFS;
  },
};
