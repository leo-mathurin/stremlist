import { z } from "zod";
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
  ProviderActions,
} from "../types";
import { targetEpisodes, UnknownTitleError } from "../types";
import { simklRequest } from "./api";
import { CONNECTION_REFS, titleType } from "./entries";
import type { LibraryItem } from "./library";
import { knownItems, markLibraryChanged, syncLibrary } from "./library";

function membershipFrom(items: LibraryItem[]) {
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
) {
  const item = { ids: syncIds(target) };
  const series = target.type === "series";

  if (intent.kind === "watchlist") {
    if (intent.add)
      return {
        path: "/sync/add-to-list",
        item: { ...item, to: "plantowatch" },
      } satisfies WriteRequest;
    await markLibraryChanged(connection.accountId);
    const current = (await syncLibrary(connection)).items.filter(
      (entry) => entry.imdb === target.imdbId,
    );
    if (
      current.length === 0 ||
      current.some((entry) => entry.status !== "plantowatch")
    )
      return null;
    return { path: "/sync/history/remove", item } satisfies WriteRequest;
  }

  if (intent.kind === "watched") {
    const path = intent.add ? "/sync/history" : "/sync/history/remove";
    const episodes = targetEpisodes(target);
    if (series && episodes.length > 0) {
      return {
        path,
        item: {
          ...episodeItem(target, episodes, watchedAtOf(intent).watched_at),
          use_tvdb_anime_seasons: true,
        },
      } satisfies WriteRequest;
    }
    if (intent.add) {
      return {
        path,
        item: series
          ? { ...item, status: "completed" }
          : { ...item, ...watchedAtOf(intent) },
      } satisfies WriteRequest;
    }
    if (series) {
      const seasons = new Set<number>();
      for (const known of await knownItems(connection, target.imdbId)) {
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
        } satisfies WriteRequest;
      }
    }
    return { path, item } satisfies WriteRequest;
  }

  if (intent.rating === null)
    return { path: "/sync/ratings/remove", item } satisfies WriteRequest;
  return {
    path: "/sync/ratings",
    item: { ...item, rating: intent.rating },
  } satisfies WriteRequest;
}

async function perform(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
) {
  const write = await buildWrite(connection, intent, target);
  if (!write) return;
  const token = await connection.getAccessToken();
  const result = await simklRequest(write.path, z.unknown(), {
    method: "POST",
    token,
    body: { [bucketOf(target)]: [write.item] },
  });
  if (countNotFound(result) > 0)
    throw new UnknownTitleError("simkl", target.imdbId);
  await markLibraryChanged(connection.accountId);
}

export const simklActions: ProviderActions = {
  kinds: ["watchlist", "watched", "rating"],

  async getMembership(connection) {
    return membershipFrom((await syncLibrary(connection)).items);
  },

  perform,

  /**
   * A Simkl title sits in exactly one status, so adding, watching or rating
   * it (rating files an unlisted title) can move it between all of them.
   * Removing a title also clears its rating, so every kind touches Ratings.
   * Airing soon follows the statuses, and a watched mark can end a paused
   * playback session.
   */
  affectedSources() {
    return CONNECTION_REFS;
  },
};
