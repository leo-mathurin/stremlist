import type { SourceEntry } from "../types";

/** The IDs object of a Trakt movie or show. */
export interface TraktIds {
  trakt?: number | null;
  slug?: string | null;
  imdb?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
}

export interface TraktMedia {
  title?: string | null;
  year?: number | null;
  ids?: TraktIds | null;
}

/**
 * One item of a Trakt response that carries a movie or a show: list and
 * watchlist items (`type` + object), chart rows (`watchers` + object), sync
 * rows (`last_watched_at` + object), up next rows (`show` + `progress`).
 */
export interface TraktItem {
  type?: string;
  movie?: TraktMedia | null;
  show?: TraktMedia | null;
  listed_at?: string | null;
  last_watched_at?: string | null;
  collected_at?: string | null;
  last_collected_at?: string | null;
  progress?: { last_watched_at?: string | null } | null;
}

const IMDB_ID = /^tt\d+$/;

export function imdbIdOf(media: TraktMedia | null | undefined): string | null {
  const imdb = media?.ids?.imdb;
  return imdb && IMDB_ID.test(imdb) ? imdb : null;
}

/** A Trakt movie or show as a Source list entry. */
export function mediaToEntry(
  media: TraktMedia,
  type: "movie" | "series",
): SourceEntry {
  const ids = media.ids ?? {};
  const entry: SourceEntry = { type };
  const imdbId = imdbIdOf(media);
  if (imdbId) entry.imdbId = imdbId;
  const externalIds: NonNullable<SourceEntry["externalIds"]> = {};
  if (typeof ids.tmdb === "number") externalIds.tmdb = { id: ids.tmdb, type };
  if (typeof ids.trakt === "number") externalIds.trakt = ids.trakt;
  if (typeof ids.tvdb === "number") externalIds.tvdb = ids.tvdb;
  if (Object.keys(externalIds).length > 0) entry.externalIds = externalIds;
  if (media.title) entry.title = media.title;
  if (typeof media.year === "number") entry.year = media.year;
  return entry;
}

/**
 * The Title behind a list item. Seasons and episodes in a list stand for
 * their show; people and anything unknown are skipped.
 */
export function itemToEntry(item: TraktItem): SourceEntry | null {
  if (item.movie && (item.type === undefined || item.type === "movie")) {
    return mediaToEntry(item.movie, "movie");
  }
  if (item.show) return mediaToEntry(item.show, "series");
  return null;
}

/** Same Title twice (several seasons of one show in a list) keeps the first. */
export function uniqueEntries(entries: SourceEntry[]): SourceEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const id =
      entry.imdbId ??
      (entry.externalIds?.trakt !== undefined
        ? `trakt:${entry.externalIds.trakt}`
        : null);
    if (!id) return true;
    const key = `${entry.type}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sort by a date ascending (oldest first, the canonical order). The sort is
 * stable, so items with the same or no date keep the Provider's order.
 */
export function oldestFirst<T>(
  items: T[],
  dateOf: (item: T) => string | null | undefined,
): T[] {
  const time = (item: T) => {
    const value = dateOf(item);
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return items
    .map((item, index) => ({ item, index, at: time(item) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1))
    .map(({ item }) => item);
}

/** m1, s1, m2, s2…: keeps each chart's rank while mixing both kinds. */
export function interleave<T>(first: T[], second: T[]): T[] {
  const result: T[] = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (i < first.length) result.push(first[i]);
    if (i < second.length) result.push(second[i]);
  }
  return result;
}
