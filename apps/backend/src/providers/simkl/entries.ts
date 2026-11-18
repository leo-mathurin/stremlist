import type { ExternalIds, SourceEntry } from "../types";
import type {
  LibraryItem,
  SimklKind,
  SimklStatus,
  SimklTitle,
} from "./library";
import { STATUSES } from "./library";

const STATUS_REFS = new Map<string, SimklStatus>(
  STATUSES.map((status) => [`me/${status}`, status]),
);
/** Everything the user watched something of, from the library snapshot. */
const HISTORY_REF = "me/history";
/** Everything the user rated, from the library snapshot. */
const RATINGS_REF = "me/ratings";
/** Source lists read from the library snapshot. */
const LIBRARY_REFS = [...STATUS_REFS.keys(), HISTORY_REF, RATINGS_REF];
/** The library joined with Simkl's airing calendar. */
export const AIRING_SOON_REF = "me/airing-soon";
/** The paused playback sessions. */
export const PLAYBACK_REF = "me/continue-watching";
/** Source lists that the Connection reads, apart from custom lists. */
export const CONNECTION_REFS = [...LIBRARY_REFS, AIRING_SOON_REF, PLAYBACK_REF];

export function titleType(
  kind: SimklKind,
  animeType?: string | null,
): "movie" | "series" {
  return kind === "movies" || animeType === "movie" ? "movie" : "series";
}

/** The Simkl page of a title, for linking back to Simkl. */
export function simklItemUrl(item: {
  simkl: number;
  kind: SimklKind;
  slug?: string;
}): string {
  const section = item.kind === "shows" ? "tv" : item.kind;
  return `https://simkl.com/${section}/${item.simkl}/${item.slug ?? ""}`;
}

export function toEntry(item: SimklTitle, addedAt?: string): SourceEntry {
  const type = titleType(item.kind, item.animeType);
  const externalIds: ExternalIds = { simkl: item.simkl };
  if (item.tmdb) externalIds.tmdb = { id: item.tmdb, type };
  return {
    imdbId: item.imdb,
    externalIds,
    type,
    title: item.title,
    year: item.year,
    sourceUrl: simklItemUrl(item),
    ...(addedAt ? { addedAt } : {}),
  };
}

/** Oldest `date` first, then by Simkl ID; items without a date first. */
function byDate(
  date: (item: LibraryItem) => string | undefined,
): (a: LibraryItem, b: LibraryItem) => number {
  return (a, b) => {
    const left = date(a) ?? "";
    const right = date(b) ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return a.simkl - b.simkl;
  };
}

/** Watched items, in the order they were last watched (oldest first). */
function historyEntries(items: LibraryItem[]): SourceEntry[] {
  return items
    .filter((item) => item.lastWatchedAt)
    .sort(byDate((item) => item.lastWatchedAt))
    .map((item) => toEntry(item, item.lastWatchedAt));
}

/** Rated items, in the order they were rated (oldest first). */
function ratingEntries(items: LibraryItem[]): SourceEntry[] {
  return items
    .filter((item) => item.rating)
    .sort(byDate((item) => item.ratedAt))
    .map((item) => toEntry(item, item.ratedAt));
}

/** The entries of one of the LIBRARY_REFS. */
export function libraryEntries(
  items: LibraryItem[],
  ref: string,
): SourceEntry[] {
  const status = STATUS_REFS.get(ref);
  if (status) return statusEntries(items, status);
  return ref === RATINGS_REF ? ratingEntries(items) : historyEntries(items);
}

function statusEntries(
  items: LibraryItem[],
  status: SimklStatus,
): SourceEntry[] {
  return (
    items
      .filter((item) => item.status === status)
      // Canonical order: oldest added first; legacy items without a date first.
      .sort(byDate((item) => item.addedAt ?? item.lastWatchedAt))
      .map((item) => toEntry(item, item.addedAt ?? item.lastWatchedAt))
  );
}
