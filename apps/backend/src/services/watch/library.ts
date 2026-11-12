/**
 * What Watch tracking reads from a library item (ADR 0003): when it turned
 * watched, which episodes are watched, and the episode list of a series.
 */
import { LruCache } from "../../lib/lru";
import { providerFetch, RateLimiter } from "../../providers/http";
import type { LibraryItem } from "../stremio";
import type { SeriesVideo } from "./bitfield";
import { stremioOrder, watchedVideos } from "./bitfield";

const CINEMETA = "https://v3-cinemeta.strem.io";
const cinemetaLimiter = new RateLimiter(20, 1000);
const videoLists = new LruCache<string, SeriesVideo[]>({
  maxEntries: 2000,
  ttlMs: 6 * 3600_000,
});

/** The episodes of a series in Stremio's order, from Cinemeta. */
async function seriesVideos(
  imdbId: string,
  fresh = false,
): Promise<SeriesVideo[]> {
  const cached = fresh ? undefined : videoLists.get(imdbId);
  if (cached) return cached;
  const response = await providerFetch(
    `${CINEMETA}/meta/series/${encodeURIComponent(imdbId)}.json`,
    { limiter: cinemetaLimiter },
  );
  // Cinemeta does not know the series: it has no episode list to compare.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Cinemeta answered ${response.status}`);
  const body = (await response.json()) as {
    meta?: { videos?: Partial<SeriesVideo>[] } | null;
  };
  const videos = stremioOrder(
    (body.meta?.videos ?? []).flatMap(({ id, season, episode, released }) =>
      typeof id === "string" &&
      typeof season === "number" &&
      typeof episode === "number" &&
      Number.isInteger(season) &&
      Number.isInteger(episode)
        ? [{ id, season, episode, released }]
        : [],
    ),
  );
  videoLists.set(imdbId, videos);
  return videos;
}

/** Cinemeta has no episode list for the series: nothing can be compared. */
export const UNLISTED = "unlisted";

/**
 * The episodes that a `watched` field marks, as "season:episode". A field
 * whose anchor episode is not in the cached list reads Cinemeta again: a
 * list cached before a new episode came out cannot place it. Null when
 * Cinemeta still cannot place it; UNLISTED when Cinemeta has no list.
 */
export async function watchedEpisodes(
  imdbId: string,
  field: string | undefined,
): Promise<Set<string> | null | typeof UNLISTED> {
  if (!field) return new Set();
  const decode = (videos: SeriesVideo[]) => {
    const ids = watchedVideos(field, videos);
    return {
      anchored:
        ids.size > 0 || videos.some((v) => field.startsWith(`${v.id}:`)),
      keys: new Set(
        videos
          .filter((v) => ids.has(v.id))
          .map((v) => `${v.season}:${v.episode}`),
      ),
    };
  };
  const videos = await seriesVideos(imdbId);
  if (videos.length === 0) return UNLISTED;
  let result = decode(videos);
  if (!result.anchored) result = decode(await seriesVideos(imdbId, true));
  return result.anchored ? result.keys : null;
}

export function mtimeOf(item: LibraryItem): number {
  const value = item._mtime;
  if (typeof value === "number") return value;
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** A movie counts as watched once Stremio counted one watch. */
export function movieWatched(item: LibraryItem | undefined): boolean {
  return (item?.state?.timesWatched ?? 0) > 0;
}

/** A watched title to send to the Destinations. */
export interface WatchedTitle {
  imdbId: string;
  type: "movie" | "series";
  episode?: { season: number; episode: number };
  /** Stremio's `lastWatched`, or the time of the change. */
  watchedAt: string;
}

function watchedAt(item: LibraryItem): string {
  const last = item.state?.lastWatched;
  if (last && !Number.isNaN(Date.parse(last))) return last;
  return new Date(mtimeOf(item) || Date.now()).toISOString();
}

/** The movie, when it turned watched since `before`. */
export function newMovie(
  item: LibraryItem,
  watchedBefore: boolean,
): WatchedTitle[] {
  return !watchedBefore && movieWatched(item)
    ? [{ imdbId: item._id, type: "movie", watchedAt: watchedAt(item) }]
    : [];
}

/** The titles of these episodes ("season:episode") of a series item. */
export function episodeTitles(
  item: LibraryItem,
  episodes: Iterable<string>,
): WatchedTitle[] {
  const at = watchedAt(item);
  return [...episodes].map((key) => {
    const [season, episode] = key.split(":").map(Number);
    return {
      imdbId: item._id,
      type: "series" as const,
      episode: { season, episode },
      watchedAt: at,
    };
  });
}

/** Whether Stremio shows this episode (`tt…:season:episode`) as watched. */
export async function isEpisodeWatched(
  item: LibraryItem | undefined,
  videoId: string,
): Promise<boolean> {
  if (!item?.state?.watched) return false;
  const [, season, episode] = videoId.split(":");
  const watched = await watchedEpisodes(item._id, item.state.watched);
  return watched instanceof Set && watched.has(`${season}:${episode}`);
}
