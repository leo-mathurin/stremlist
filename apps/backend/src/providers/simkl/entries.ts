import type { ExternalIds, SourceEntry } from "../types";
import type {
  LibraryItem,
  SimklKind,
  SimklStatus,
  SimklTitle,
} from "./library";
import { STATUSES } from "./library";

export const STATUS_REFS = new Map<string, SimklStatus>(
  STATUSES.map((status) => [`me/${status}`, status]),
);
/** Everything the user watched something of, from the library snapshot. */
export const HISTORY_REF = "me/history";
/** Source lists read from the library snapshot. */
export const LIBRARY_REFS = [...STATUS_REFS.keys(), HISTORY_REF];

export function titleType(
  kind: SimklKind,
  animeType?: string | null,
): "movie" | "series" {
  if (kind === "movies") return "movie";
  return animeType === "movie" ? "movie" : "series";
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
  if (item.tvdb) externalIds.tvdb = item.tvdb;
  if (item.mal) externalIds.mal = item.mal;
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

/** Canonical order: oldest added first; legacy items without a date first. */
function compareAdded(a: LibraryItem, b: LibraryItem): number {
  const left = a.addedAt ?? a.lastWatchedAt ?? "";
  const right = b.addedAt ?? b.lastWatchedAt ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return a.simkl - b.simkl;
}

/** Watched items, in the order they were last watched (oldest first). */
export function historyEntries(items: LibraryItem[]): SourceEntry[] {
  return items
    .filter((item) => item.lastWatchedAt)
    .sort((a, b) =>
      (a.lastWatchedAt ?? "") === (b.lastWatchedAt ?? "")
        ? a.simkl - b.simkl
        : (a.lastWatchedAt ?? "") < (b.lastWatchedAt ?? "")
          ? -1
          : 1,
    )
    .map((item) => toEntry(item, item.lastWatchedAt));
}

export function statusEntries(
  items: LibraryItem[],
  status: SimklStatus,
): SourceEntry[] {
  return items
    .filter((item) => item.status === status)
    .sort(compareAdded)
    .map((item) => toEntry(item, item.addedAt ?? item.lastWatchedAt));
}
