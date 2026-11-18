import type { ExternalIds } from "../types";
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
const HISTORY_REF = "me/history";
const RATINGS_REF = "me/ratings";
/** Source lists read from the library snapshot. */
export const LIBRARY_REFS = [...STATUS_REFS.keys(), HISTORY_REF, RATINGS_REF];

export function titleType(kind: SimklKind, animeType?: string | null) {
  return kind === "movies" || animeType === "movie" ? "movie" : "series";
}

/** The Simkl page of a title, for linking back to Simkl. */
export function simklItemUrl(item: {
  simkl: number;
  kind: SimklKind;
  slug?: string;
}) {
  const section = item.kind === "shows" ? "tv" : item.kind;
  return `https://simkl.com/${section}/${item.simkl}/${item.slug ?? ""}`;
}

export function toEntry(item: SimklTitle, addedAt?: string) {
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

function byDate(date: (item: LibraryItem) => string | undefined) {
  return (a, b) => {
    const left = date(a) ?? "";
    const right = date(b) ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return a.simkl - b.simkl;
  };
}

function historyEntries(items: LibraryItem[]) {
  return items
    .filter((item) => item.lastWatchedAt)
    .sort(byDate((item) => item.lastWatchedAt))
    .map((item) => toEntry(item, item.lastWatchedAt));
}

function ratingEntries(items: LibraryItem[]) {
  return items
    .filter((item) => item.rating)
    .sort(byDate((item) => item.ratedAt))
    .map((item) => toEntry(item, item.ratedAt));
}

/** The entries of one of the LIBRARY_REFS. */
export function libraryEntries(items: LibraryItem[], ref: string) {
  const status = STATUS_REFS.get(ref);
  if (status) return statusEntries(items, status);
  return ref === RATINGS_REF ? ratingEntries(items) : historyEntries(items);
}

function statusEntries(items: LibraryItem[], status: SimklStatus) {
  return items
    .filter((item) => item.status === status)
    .sort(byDate((item) => item.addedAt ?? item.lastWatchedAt))
    .map((item) => toEntry(item, item.addedAt ?? item.lastWatchedAt));
}
