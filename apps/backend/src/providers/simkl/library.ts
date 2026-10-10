import { asImdbId } from "@stremlist/shared/constants";
import type { ConnectionAccess } from "../types";
import { connectionToken } from "../types";
import { isMaxItemsError, simklRequest } from "./api";
import { libraryKey, readState, STATE_VERSION, writeState } from "./state";

/**
 * Each user has a small daily request allowance (500 on a free plan), shared
 * with every other app they connected. Reads that arrive within this window
 * reuse the last snapshot without even asking Simkl whether it changed.
 */
const SYNC_GATE_MS = 2 * 60_000;

/** Simkl's media types, in the order the full library is read. */
export const KINDS = ["shows", "movies", "anime"] as const;
export type SimklKind = (typeof KINDS)[number];

export type SimklStatus =
  | "watching"
  | "plantowatch"
  | "hold"
  | "completed"
  | "dropped";

export const STATUSES: readonly SimklStatus[] = [
  "watching",
  "plantowatch",
  "hold",
  "completed",
  "dropped",
];

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type RawIds = Record<string, unknown>;

interface RawEpisode {
  number?: unknown;
  tvdb?: { season?: unknown; episode?: unknown } | null;
}

interface RawEntry {
  added_to_watchlist_at?: string | null;
  last_watched_at?: string | null;
  user_rating?: number | null;
  status?: string;
  watched_episodes_count?: number;
  anime_type?: string | null;
  show?: { title?: string; year?: number | null; ids?: RawIds };
  movie?: { title?: string; year?: number | null; ids?: RawIds };
  seasons?: { number?: unknown; episodes?: RawEpisode[] }[];
}

type RawLibrary = Partial<Record<SimklKind, RawEntry[]>>;

type ActivityBlock = Record<string, string | null | undefined>;

export interface SimklActivities {
  all?: string | null;
  tv_shows?: ActivityBlock;
  anime?: ActivityBlock;
  movies?: ActivityBlock;
  custom_lists?: { lists?: { all?: string | null } };
}

const ACTIVITY_BLOCKS = ["tv_shows", "anime", "movies"] as const;
/** Activity keys that do not change which items sit in which status. */
const NON_STATUS_ACTIVITIES = new Set([
  "all",
  "rated_at",
  "playback",
  "removed_from_list",
]);

export function toInt(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
    : undefined;
}

/** The IDs that Simkl gives for a title, wherever the title comes from. */
export interface SimklIds {
  simkl?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
  mal?: number;
}

/** Library rows carry `simkl`, custom list items `simkl_id`. */
export function parseIds(raw: RawIds): SimklIds {
  return {
    simkl: toInt(raw.simkl) ?? toInt(raw.simkl_id),
    slug: typeof raw.slug === "string" ? raw.slug : undefined,
    imdb: asImdbId(raw.imdb),
    tmdb: toInt(raw.tmdb),
    tvdb: toInt(raw.tvdb),
    mal: toInt(raw.mal),
  };
}

// ---------------------------------------------------------------------------
// The library: every item of the user's five statuses, with watch state
// ---------------------------------------------------------------------------

/** A Simkl title, from the library or from a custom list. */
export interface SimklTitle extends SimklIds {
  simkl: number;
  kind: SimklKind;
  title?: string;
  year?: number;
  animeType?: string;
}

export interface LibraryItem extends SimklTitle {
  status: SimklStatus;
  addedAt?: string;
  lastWatchedAt?: string;
  rating?: number;
  watchedEpisodes: number;
  /**
   * Watched episodes as "season:episode" (TVDB numbering for anime), or
   * undefined when the read did not load episodes.
   */
  episodes?: string[];
}

export interface LibrarySnapshot {
  version: number;
  /** The Simkl user the snapshot belongs to: a reconnect may change it. */
  username: string | null;
  /** The whole /sync/activities response read before the snapshot's data. */
  activities: SimklActivities;
  /** When activities were last checked; 0 forces a check on the next read. */
  checkedAt: number;
  items: LibraryItem[];
}

function normalizeStatus(value: string | undefined): SimklStatus | null {
  // Older client IDs see "notinteresting" where newer ones see "dropped".
  if (value === "notinteresting") return "dropped";
  return STATUSES.find((status) => status === value) ?? null;
}

function parseEpisodes(entry: RawEntry): string[] {
  const episodes = new Set<string>();
  for (const season of entry.seasons ?? []) {
    for (const episode of season.episodes ?? []) {
      // Anime use AniDB numbering; the TVDB mapping matches IMDb seasons.
      const mappedSeason = episode.tvdb ? Number(episode.tvdb.season) : NaN;
      const mappedEpisode = episode.tvdb ? Number(episode.tvdb.episode) : NaN;
      const s = Number.isInteger(mappedSeason)
        ? mappedSeason
        : Number(season.number);
      const e = Number.isInteger(mappedEpisode)
        ? mappedEpisode
        : Number(episode.number);
      if (Number.isInteger(s) && Number.isInteger(e)) episodes.add(`${s}:${e}`);
    }
  }
  return [...episodes];
}

function parseEntry(
  kind: SimklKind,
  entry: RawEntry,
  episodesLoaded: boolean,
): LibraryItem | null {
  const media = entry.movie ?? entry.show;
  const { simkl, ...ids } = parseIds(media?.ids ?? {});
  const status = normalizeStatus(entry.status);
  if (!simkl || !status) return null;
  const rating = toInt(entry.user_rating);
  return {
    simkl,
    kind,
    status,
    ...ids,
    title: media?.title,
    year: toInt(media?.year),
    animeType: entry.anime_type ?? undefined,
    addedAt: entry.added_to_watchlist_at ?? undefined,
    lastWatchedAt: entry.last_watched_at ?? undefined,
    rating: rating && rating <= 10 ? rating : undefined,
    watchedEpisodes: entry.watched_episodes_count ?? 0,
    episodes: entry.seasons
      ? parseEpisodes(entry)
      : episodesLoaded
        ? []
        : undefined,
  };
}

function parseLibrary(raw: RawLibrary, episodesLoaded: boolean): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const kind of KINDS) {
    for (const entry of raw[kind] ?? []) {
      const item = parseEntry(kind, entry, episodesLoaded);
      if (item) items.push(item);
    }
  }
  return items;
}

// Episode rows let Actions show which episodes are watched. A very large
// library can exceed what Simkl builds in one response (400 max_items), so
// fall back to lighter reads instead of failing.
const READ_VARIANTS: { params: Record<string, string>; episodes: boolean }[] = [
  {
    params: { extended: "full_anime_seasons", include_all_episodes: "yes" },
    episodes: true,
  },
  {
    params: {
      extended: "full_anime_seasons",
      include_all_episodes: "original",
    },
    episodes: true,
  },
  { params: {}, episodes: false },
];

async function readItems(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<LibraryItem[]> {
  for (let index = 0; ; index++) {
    const variant = READ_VARIANTS[index];
    try {
      const raw = await simklRequest<RawLibrary>(path, {
        token,
        params: { ...params, ...variant.params },
      });
      return parseLibrary(raw, variant.episodes);
    } catch (error) {
      if (isMaxItemsError(error) && index < READ_VARIANTS.length - 1) continue;
      throw error;
    }
  }
}

/** Phase 1 of Simkl's sync model: the whole library, one type at a time. */
async function fullRead(token: string): Promise<LibraryItem[]> {
  const items: LibraryItem[] = [];
  for (const kind of KINDS) {
    items.push(...(await readItems(`/sync/all-items/${kind}`, token)));
  }
  return items;
}

function bucketsMoved(
  previous: SimklActivities,
  next: SimklActivities,
  matches: (key: string) => boolean,
): boolean {
  return ACTIVITY_BLOCKS.some((block) => {
    const before = previous[block] ?? {};
    const after = next[block] ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].some((key) => matches(key) && before[key] !== after[key]);
  });
}

/** Phase 2: only what moved since the previous snapshot's `all`. */
async function applyChanges(
  token: string,
  previous: LibrarySnapshot,
  activities: SimklActivities,
): Promise<LibraryItem[]> {
  const dateFrom = previous.activities.all ?? "";
  const items = new Map(previous.items.map((item) => [item.simkl, item]));

  if (
    bucketsMoved(
      previous.activities,
      activities,
      (key) => !NON_STATUS_ACTIVITIES.has(key),
    )
  ) {
    for (const item of await readItems("/sync/all-items", token, {
      date_from: dateFrom,
    })) {
      items.set(item.simkl, item);
    }
  }

  // date_from never returns removed items: diff the current IDs instead.
  if (
    bucketsMoved(
      previous.activities,
      activities,
      (key) => key === "removed_from_list",
    )
  ) {
    const raw = await simklRequest<RawLibrary>("/sync/all-items", {
      token,
      params: { extended: "simkl_ids_only" },
    });
    const current = new Set<number>();
    for (const kind of KINDS) {
      for (const entry of raw[kind] ?? []) {
        const { simkl } = parseIds((entry.movie ?? entry.show)?.ids ?? {});
        if (simkl) current.add(simkl);
      }
    }
    for (const simkl of [...items.keys()]) {
      if (!current.has(simkl)) items.delete(simkl);
    }
  }

  // A rating change never shows up in the all-items delta.
  if (
    bucketsMoved(previous.activities, activities, (key) => key === "rated_at")
  ) {
    const raw = await simklRequest<RawLibrary>("/sync/ratings", {
      token,
      params: { date_from: dateFrom },
    });
    for (const row of parseLibrary(raw, false)) {
      const existing = items.get(row.simkl);
      if (existing) {
        items.set(row.simkl, { ...existing, rating: row.rating });
      } else {
        items.set(row.simkl, row);
      }
    }
  }

  return [...items.values()];
}

function usableSnapshot(
  snapshot: LibrarySnapshot | null,
  connection: ConnectionAccess,
): LibrarySnapshot | null {
  if (snapshot?.version !== STATE_VERSION) return null;
  if (snapshot.username !== connection.username) return null;
  return snapshot;
}

const inFlightSyncs = new Map<string, Promise<LibrarySnapshot>>();

/** Test hook: forget the syncs in flight. */
export function clearInFlightSyncs(): void {
  inFlightSyncs.clear();
}

/** After a disconnect: a later read must not join a sync of the old tokens. */
export function forgetInFlightSync(accountId: string): void {
  inFlightSyncs.delete(accountId);
}

/**
 * The user's library, kept in sync the way Simkl requires: always ask
 * /sync/activities first, reuse the previous snapshot when nothing moved, and
 * otherwise fetch only the delta. The full library is read once per
 * Connection (and again only if the snapshot is lost).
 */
export function syncLibrary(
  connection: ConnectionAccess,
): Promise<LibrarySnapshot> {
  const key = connection.accountId;
  const existing = inFlightSyncs.get(key);
  if (existing) return existing;
  const sync = runSync(connection);
  inFlightSyncs.set(key, sync);
  const clear = () => {
    if (inFlightSyncs.get(key) === sync) inFlightSyncs.delete(key);
  };
  void sync.then(clear, clear);
  return sync;
}

async function runSync(connection: ConnectionAccess): Promise<LibrarySnapshot> {
  const key = libraryKey(connection.accountId);
  const previous = usableSnapshot(
    await readState<LibrarySnapshot>(key),
    connection,
  );
  if (previous && Date.now() - previous.checkedAt < SYNC_GATE_MS)
    return previous;

  const token = await connectionToken(connection);
  // Read before the data it anchors, so a change made during the read is
  // newer than the saved timestamp and comes back in the next delta.
  const activities = await simklRequest<SimklActivities>("/sync/activities", {
    token,
  });

  let items: LibraryItem[];
  if (!previous?.activities.all) {
    items = await fullRead(token);
  } else if (activities.all === previous.activities.all) {
    items = previous.items;
  } else {
    items = await applyChanges(token, previous, activities);
  }

  const snapshot: LibrarySnapshot = {
    version: STATE_VERSION,
    username: connection.username,
    activities,
    checkedAt: Date.now(),
    items,
  };
  await writeState(key, snapshot);
  return snapshot;
}

/** The library items of one Title, from the last snapshot. */
export async function knownItems(
  accountId: string,
  imdbId: string,
): Promise<LibraryItem[]> {
  const snapshot = await readState<LibrarySnapshot>(libraryKey(accountId));
  return snapshot?.items.filter((item) => item.imdb === imdbId) ?? [];
}

/** After an Action, the next read checks activities instead of the gate. */
export async function markLibraryChanged(accountId: string): Promise<void> {
  const key = libraryKey(accountId);
  const snapshot = await readState<LibrarySnapshot>(key);
  if (snapshot) await writeState(key, { ...snapshot, checkedAt: 0 });
}
