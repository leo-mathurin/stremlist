import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ADDON_VERSION } from "@stremlist/shared/constants";
import { CONNECTION_SOURCES } from "@stremlist/shared/providers";
import { getR2Bucket, getR2Client } from "../lib/r2";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import { ensureOk, HttpError, providerFetch, RateLimiter } from "./http";
import { oauthClient, revokeToken } from "./oauth-app";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  ExternalIds,
  Membership,
  PagedRead,
  ProviderAdapter,
  SourceEntry,
  SourceValidation,
} from "./types";
import { connectionToken, SourceUnavailableError } from "./types";

const API = "https://api.simkl.com";
const APP_NAME = "stremlist";

// Simkl allows 10 GET and 1 POST per second for each user token. A POST over
// the limit gets the token blocked for a while, so writes are never retried.
const getLimiter = new RateLimiter(10, 1000);
const postLimiter = new RateLimiter(1, 1000);

/**
 * Each user has a small daily request allowance (500 on a free plan), shared
 * with every other app they connected. Reads that arrive within this window
 * reuse the last snapshot without even asking Simkl whether it changed.
 */
const SYNC_GATE_MS = 2 * 60_000;
/** Auto lists are rebuilt daily without moving /sync/activities. */
const AUTO_LIST_MAX_AGE_MS = 24 * 60 * 60_000;
const LIST_PAGE_LIMIT = 500;
// Simkl refuses page * limit above 10000.
const LIST_MAX_PAGES = 20;
const STATE_VERSION = 1;

type SimklKind = "movies" | "shows" | "anime";
type SimklStatus =
  | "watching"
  | "plantowatch"
  | "hold"
  | "completed"
  | "dropped";

const STATUSES: readonly SimklStatus[] = [
  "watching",
  "plantowatch",
  "hold",
  "completed",
  "dropped",
];

const STATUS_REFS = new Map<string, SimklStatus>(
  STATUSES.map((status) => [`me/${status}`, status]),
);
const LIST_REF = /^me\/lists\/(\d+)$/;
/** Everything the user watched something of, from the library snapshot. */
const HISTORY_REF = "me/history";

const client = oauthClient("SIMKL");
const { clientId } = client;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Every Simkl call carries the app's client ID, name and version in the URL. */
function apiUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, API);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("client_id", clientId() ?? "");
  url.searchParams.set("app-name", APP_NAME);
  url.searchParams.set("app-version", ADDON_VERSION);
  return url.toString();
}

interface RequestOptions {
  method?: "GET" | "POST";
  token: string;
  params?: Record<string, string>;
  body?: unknown;
}

async function simklRequest<T>(
  path: string,
  options: RequestOptions,
): Promise<T> {
  const id = clientId();
  if (!id) {
    throw new SourceUnavailableError("unavailable", "Simkl is not configured");
  }
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "simkl-api-key": id,
    Authorization: `Bearer ${options.token}`,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const url = apiUrl(path, options.params);
  const response = await providerFetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    limiter: method === "GET" ? getLimiter : postLimiter,
    retryOn429: method === "GET",
  });
  if (response.status === 401) {
    // Expired or revoked grant: the user has to connect Simkl again.
    throw new SourceUnavailableError(
      "needs_connection",
      "Simkl rejected the access token",
    );
  }
  await ensureOk(response, url);
  return (await response.json()) as T;
}

function isMaxItemsError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    error.body.includes("max_items")
  );
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type RawIds = Record<string, unknown>;

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

interface SimklActivities {
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

interface WriteResult {
  not_found?: Record<string, unknown[] | undefined>;
}

function toInt(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
    : undefined;
}

function toImdbId(value: unknown): string | undefined {
  return typeof value === "string" && /^tt\d+$/.test(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// The library: every item of the user's five statuses, with watch state
// ---------------------------------------------------------------------------

interface LibraryItem {
  simkl: number;
  kind: SimklKind;
  status: SimklStatus;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
  mal?: number;
  title?: string;
  year?: number;
  animeType?: string;
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

interface LibrarySnapshot {
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
  const ids = media?.ids ?? {};
  const simkl = toInt(ids.simkl ?? ids.simkl_id);
  const status = normalizeStatus(entry.status);
  if (!simkl || !status) return null;
  const rating = toInt(entry.user_rating);
  return {
    simkl,
    kind,
    status,
    slug: typeof ids.slug === "string" ? ids.slug : undefined,
    imdb: toImdbId(ids.imdb),
    tmdb: toInt(ids.tmdb),
    tvdb: toInt(ids.tvdb),
    mal: toInt(ids.mal),
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
  for (const kind of ["shows", "movies", "anime"] as const) {
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
  for (const kind of ["shows", "movies", "anime"] as const) {
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
    for (const kind of ["shows", "movies", "anime"] as const) {
      for (const entry of raw[kind] ?? []) {
        const ids = (entry.movie ?? entry.show)?.ids ?? {};
        const simkl = toInt(ids.simkl ?? ids.simkl_id);
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

// ---------------------------------------------------------------------------
// Per-Connection state in R2, next to the Action membership
// ---------------------------------------------------------------------------

function libraryKey(accountId: string): string {
  return `connections/${accountId}/simkl/library.json`;
}

function listKey(accountId: string, listId: string): string {
  return `connections/${accountId}/simkl/lists/${listId}.json`;
}

// Only a fallback when R2 is unreachable: R2 is the shared truth, so an
// instance never trusts an older copy than another instance wrote.
const memoryState = new Map<string, unknown>();

async function readState<T>(key: string): Promise<T | null> {
  try {
    const response = await getR2Client().send(
      new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    );
    if (!response.Body) return null;
    const value = JSON.parse(await response.Body.transformToString()) as T;
    memoryState.set(key, value);
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") return null;
    return (memoryState.get(key) as T | undefined) ?? null;
  }
}

async function writeState(key: string, value: unknown): Promise<void> {
  memoryState.set(key, value);
  try {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: key,
        Body: Buffer.from(JSON.stringify(value)),
        ContentType: "application/json",
        CacheControl: "private, max-age=0, must-revalidate",
      }),
    );
  } catch (error) {
    console.error(
      `Failed to save Simkl state ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Test hook: forget the in-memory fallback state. */
export function resetSimklState(): void {
  memoryState.clear();
  inFlightSyncs.clear();
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

/**
 * The user's library, kept in sync the way Simkl requires: always ask
 * /sync/activities first, reuse the previous snapshot when nothing moved, and
 * otherwise fetch only the delta. The full library is read once per
 * Connection (and again only if the snapshot is lost).
 */
function syncLibrary(connection: ConnectionAccess): Promise<LibrarySnapshot> {
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

/** After an Action, the next read checks activities instead of the gate. */
async function markLibraryChanged(accountId: string): Promise<void> {
  const key = libraryKey(accountId);
  const snapshot = await readState<LibrarySnapshot>(key);
  if (snapshot) await writeState(key, { ...snapshot, checkedAt: 0 });
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function titleType(
  kind: SimklKind | "tv",
  animeType?: string | null,
): "movie" | "series" {
  if (kind === "movies") return "movie";
  return animeType === "movie" ? "movie" : "series";
}

function toEntry(item: LibraryItem): SourceEntry {
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
function historyEntries(items: LibraryItem[]): SourceEntry[] {
  return items
    .filter((item) => item.lastWatchedAt)
    .sort((a, b) =>
      (a.lastWatchedAt ?? "") === (b.lastWatchedAt ?? "")
        ? a.simkl - b.simkl
        : (a.lastWatchedAt ?? "") < (b.lastWatchedAt ?? "")
          ? -1
          : 1,
    )
    .map(toEntry);
}

function statusEntries(
  items: LibraryItem[],
  status: SimklStatus,
): SourceEntry[] {
  return items
    .filter((item) => item.status === status)
    .sort(compareAdded)
    .map(toEntry);
}

/** The Simkl page of a library item, for linking back to Simkl. */
export function simklItemUrl(item: {
  simkl: number;
  kind: SimklKind;
  slug?: string;
}): string {
  const section = item.kind === "shows" ? "tv" : item.kind;
  return `https://simkl.com/${section}/${item.simkl}/${item.slug ?? ""}`;
}

// ---------------------------------------------------------------------------
// Custom lists (beta, PRO and VIP only)
// ---------------------------------------------------------------------------

interface RawListItem {
  title?: string;
  year?: number | null;
  type?: string;
  anime_type?: string | null;
  ids?: RawIds;
}

interface RawListPage {
  error?: string;
  name?: string;
  type?: string;
  media_type?: string;
  items?: RawListItem[];
  pagination?: { total_pages?: number };
}

interface ListSnapshot {
  version: number;
  username: string | null;
  /** custom_lists.lists.all from /sync/activities when the list was read. */
  gate: string;
  listType?: string;
  premiumOnly?: boolean;
  fetchedAt: number;
  entries: SourceEntry[];
  /** False when LIST_MAX_PAGES cut the list short. Missing: read again. */
  complete?: boolean;
}

function premiumOnlyError(): SourceUnavailableError {
  return new SourceUnavailableError(
    "premium_only",
    "Simkl custom lists need a Simkl PRO or VIP account",
  );
}

async function readListPage(
  token: string,
  listId: string,
  page: number,
  limit: number,
): Promise<RawListPage> {
  let data: RawListPage;
  try {
    data = await simklRequest<RawListPage>(`/lists/${listId}`, {
      token,
      params: { limit: String(limit), page: String(page) },
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      throw new SourceUnavailableError(
        "private",
        `Simkl list ${listId} is private`,
      );
    }
    if (error instanceof HttpError && error.status === 404) {
      throw new SourceUnavailableError(
        "not_found",
        `Simkl list ${listId} not found`,
      );
    }
    throw error;
  }
  // A free account gets HTTP 200 with an error body instead of the list.
  if (data.error === "premium_only") throw premiumOnlyError();
  if (data.error) {
    throw new SourceUnavailableError(
      "unavailable",
      `Simkl list ${listId}: ${data.error}`,
    );
  }
  if (!Array.isArray(data.items)) {
    throw new SourceUnavailableError(
      "unavailable",
      `Simkl list ${listId} has no items`,
    );
  }
  return data;
}

function listItemEntry(item: RawListItem): SourceEntry | null {
  const ids = item.ids ?? {};
  const simkl = toInt(ids.simkl_id ?? ids.simkl);
  if (!simkl) return null;
  const type =
    item.type === "movie" ? "movie" : titleType("tv", item.anime_type);
  const externalIds: ExternalIds = { simkl };
  const tmdb = toInt(ids.tmdb);
  if (tmdb) externalIds.tmdb = { id: tmdb, type };
  const tvdb = toInt(ids.tvdb);
  if (tvdb) externalIds.tvdb = tvdb;
  const mal = toInt(ids.mal);
  if (mal) externalIds.mal = mal;
  const kind: SimklKind =
    item.type === "anime" ? "anime" : type === "movie" ? "movies" : "shows";
  return {
    imdbId: toImdbId(ids.imdb),
    externalIds,
    type,
    title: item.title,
    year: toInt(item.year),
    sourceUrl: simklItemUrl({
      simkl,
      kind,
      slug: typeof ids.slug === "string" ? ids.slug : undefined,
    }),
  };
}

/** A custom list in the owner's order, re-read only when activities say so. */
async function fetchCustomList(
  connection: ConnectionAccess,
  listId: string,
): Promise<PagedRead<SourceEntry>> {
  const library = await syncLibrary(connection);
  const gate = library.activities.custom_lists?.lists?.all ?? null;
  const key = listKey(connection.accountId, listId);
  const previous = await readState<ListSnapshot>(key);
  if (
    gate &&
    previous?.version === STATE_VERSION &&
    previous.username === connection.username &&
    previous.gate === gate &&
    // Snapshots from before `complete` existed may have been cut short by
    // LIST_MAX_PAGES: read them again instead of guessing.
    (previous.premiumOnly || previous.complete !== undefined) &&
    ((previous.listType !== "auto" && !previous.premiumOnly) ||
      Date.now() - previous.fetchedAt < AUTO_LIST_MAX_AGE_MS)
  ) {
    if (previous.premiumOnly) throw premiumOnlyError();
    return { items: previous.entries, complete: previous.complete ?? false };
  }

  const token = await connectionToken(connection);
  const save = (
    snapshot: Omit<ListSnapshot, "version" | "username" | "gate" | "fetchedAt">,
  ) =>
    gate
      ? writeState(key, {
          version: STATE_VERSION,
          username: connection.username,
          gate,
          fetchedAt: Date.now(),
          ...snapshot,
        } satisfies ListSnapshot)
      : Promise.resolve();

  const entries: SourceEntry[] = [];
  let listType: string | undefined;
  let complete = false;
  try {
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const data = await readListPage(token, listId, page, LIST_PAGE_LIMIT);
      listType = data.type;
      for (const item of data.items ?? []) {
        const entry = listItemEntry(item);
        if (entry) entries.push(entry);
      }
      if (page >= (data.pagination?.total_pages ?? 1)) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    if (
      error instanceof SourceUnavailableError &&
      error.reason === "premium_only"
    ) {
      await save({ premiumOnly: true, entries: [] });
    }
    throw error;
  }
  await save({ listType, entries, complete });
  return { items: entries, complete };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function membershipFrom(items: LibraryItem[]): Membership {
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

async function knownItems(
  accountId: string,
  imdbId: string,
): Promise<LibraryItem[]> {
  const snapshot = await readState<LibrarySnapshot>(libraryKey(accountId));
  return snapshot?.items.filter((item) => item.imdb === imdbId) ?? [];
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

/** Source lists read from the library snapshot. */
const LIBRARY_REFS = [...STATUS_REFS.keys(), HISTORY_REF];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function requireConnection(ctx: {
  connection: ConnectionAccess | null;
}): ConnectionAccess {
  if (!ctx.connection) {
    throw new SourceUnavailableError(
      "needs_connection",
      "Simkl lists need a Connection",
    );
  }
  return ctx.connection;
}

/**
 * Simkl: the Connection's own statuses (`me/plantowatch`, `me/watching`,
 * `me/completed`, `me/hold`, `me/dropped`, with movies, shows and anime) and
 * custom lists (`me/lists/{id}`, Simkl PRO and VIP only), through OAuth
 * (AUTH V2). Reads follow Simkl's activities-first sync model; the library
 * snapshot lives in R2 under the Account's Connection.
 */
export const simklProvider: ProviderAdapter = {
  id: "simkl",
  freshnessMs: 60 * 60_000,

  async validateSource(ref, ctx): Promise<SourceValidation> {
    const fromLibrary = LIBRARY_REFS.includes(ref);
    const listId = LIST_REF.exec(ref)?.[1];
    if (!fromLibrary && !listId) return { ok: false, reason: "not_found" };
    if (!ctx.connection) return { ok: false, reason: "needs_connection" };

    if (fromLibrary) {
      const source = CONNECTION_SOURCES.simkl?.find(
        (entry) => entry.ref === ref,
      );
      return {
        ok: true,
        ref,
        suggestedTitle: source?.label,
        defaultDisplayMode: source?.defaultDisplayMode,
      };
    }
    try {
      const token = await connectionToken(ctx.connection);
      const page = await readListPage(token, listId ?? "", 1, 1);
      return {
        ok: true,
        ref,
        suggestedTitle: page.name,
        defaultDisplayMode: page.media_type === "movies" ? "movie" : "series",
      };
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        return { ok: false, reason: error.reason, message: error.message };
      }
      throw error;
    }
  },

  async fetchSource(ref, ctx) {
    const status = STATUS_REFS.get(ref);
    const listId = LIST_REF.exec(ref)?.[1];
    if (!status && !listId && ref !== HISTORY_REF) {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown Simkl source ${ref}`,
      );
    }
    const connection = requireConnection(ctx);
    if (listId) {
      const { items, complete } = await fetchCustomList(connection, listId);
      return { entries: items, complete };
    }
    const library = await syncLibrary(connection);
    return {
      entries: status
        ? statusEntries(library.items, status)
        : historyEntries(library.items),
    };
  },

  resolutionKey(entry) {
    const simkl = entry.externalIds?.simkl;
    return simkl ? { namespace: "simkl", externalId: String(simkl) } : null;
  },

  // Anime often have no IMDb ID on Simkl, but many have a TMDB ID.
  resolverStrategies: [tmdbExternalIdsStrategy],

  actions: {
    kinds: ["watchlist", "watched", "rating"],

    async getMembership(connection) {
      return membershipFrom((await syncLibrary(connection)).items);
    },

    async perform(connection, intent, target) {
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
    },

    // A Simkl title sits in exactly one status, so adding, watching or rating
    // it (rating files an unlisted title) can move it between all of them.
    affectedSources() {
      return LIBRARY_REFS;
    },
  },

  oauth: {
    authorizeUrl: "https://simkl.com/oauth2/authorize",
    tokenUrl: `${API}/oauth2/token`,
    ...client,
    // Without media:write (exact spelling), Simkl silently grants read-only.
    scopes: ["media:read", "media:write"],

    revoke: (token) =>
      revokeToken(`${API}/oauth2/revoke`, token, client, postLimiter),

    async fetchUsername(token) {
      const data = await simklRequest<{ user?: { name?: string } }>(
        "/users/settings",
        {
          token,
        },
      );
      const name = data.user?.name?.trim();
      if (!name) return null;
      return name;
    },
  },
};
