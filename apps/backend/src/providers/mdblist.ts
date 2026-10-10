import type { DisplayMode } from "@stremlist/shared/constants";
import { asImdbId } from "@stremlist/shared/constants";
import type { ConnectionSource } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import {
  HttpError,
  providerFetch,
  providerFetchJson,
  RateLimiter,
  sourceErrorFromHttp,
} from "./http";
import { oauthClient, revokeToken } from "./oauth-app";
import { readPages } from "./paging";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
  PagedRead,
  ProviderAdapter,
  ProviderContext,
  SourceEntry,
  SourceSnapshot,
  SourceValidation,
} from "./types";
import { connectionToken, SourceUnavailableError } from "./types";

const API = "https://api.mdblist.com";
const PAGE_SIZE = 1000;
// A safety stop for a broken cursor. MDBList lists hold at most 10,000 items
// on the free tier, and supporter tiers stay well below this.
const MAX_PAGES = 50;

/**
 * MDBList allows 1,000 reads and 300 writes per fixed 5-minute window, per
 * MDBList account and shared with every other app of that user. These
 * limiters keep one process below 90% of it, per Connection.
 */
const WINDOW_MS = 5 * 60_000;
const READS_PER_WINDOW = 900;
const WRITES_PER_WINDOW = 270;
const MAX_TRACKED_USERS = 500;

interface UserLimiters {
  read: RateLimiter;
  write: RateLimiter;
}

const limitersByUser = new Map<string, UserLimiters>();

function limitersFor(connection: ConnectionAccess): UserLimiters {
  const key = connection.username?.toLowerCase() ?? "";
  let limiters = limitersByUser.get(key);
  if (!limiters) {
    if (limitersByUser.size >= MAX_TRACKED_USERS) {
      const oldest = limitersByUser.keys().next().value;
      if (oldest !== undefined) limitersByUser.delete(oldest);
    }
    limiters = {
      read: new RateLimiter(READS_PER_WINDOW, WINDOW_MS),
      write: new RateLimiter(WRITES_PER_WINDOW, WINDOW_MS),
    };
    limitersByUser.set(key, limiters);
  }
  return limiters;
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields Stremlist reads)
// ---------------------------------------------------------------------------

interface MdblistIds {
  mdblist?: string | null;
  imdb?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
}

/** One item of a list, watchlist or external list (`unified=true`). */
interface MdblistItem {
  /** The TMDB ID for movies and shows. */
  id?: number | null;
  mediatype?: string | null;
  imdb_id?: string | null;
  ids?: MdblistIds | null;
  title?: string | null;
  release_year?: number | null;
  runtime?: number | null;
  watchlist_at?: string | null;
}

interface MdblistListInfo {
  id?: number;
  name?: string;
  slug?: string;
  mediatype?: string | null;
  private?: boolean;
  user_name?: string;
}

type ListInfoResponse = MdblistListInfo | MdblistListInfo[] | null;

interface MdblistUserListSummary {
  id?: number;
  name?: string;
  mediatype?: string | null;
}

interface SyncMedia {
  ids?: MdblistIds | null;
}

interface SyncEpisode {
  season?: number;
  number?: number;
  show?: SyncMedia | null;
}

/** GET /sync/watched and GET /sync/ratings. */
interface SyncPage {
  movies?: { movie?: SyncMedia | null; rating?: number | null }[];
  shows?: { show?: SyncMedia | null; rating?: number | null }[];
  episodes?: { episode?: SyncEpisode | null }[];
  pagination?: { has_more?: boolean; next_cursor?: string | null };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Turn an MDBList error response into the reason a Source list cannot be
 * read. MDBList answers 403 both for a revoked token ("Invalid OAuth token")
 * and for a list that the user may not see.
 */
function toSourceError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  let message = "";
  try {
    const parsed = JSON.parse(error.body) as { error?: unknown } | null;
    message = typeof parsed?.error === "string" ? parsed.error : "";
  } catch {
    message = error.body.slice(0, 200);
  }
  const { status } = error;
  const detail = message || status;
  if (status === 401 || (status === 403 && /token/i.test(message))) {
    return new SourceUnavailableError(
      "needs_connection",
      `MDBList refused the Connection: ${detail}`,
    );
  }
  const reasons: Partial<Record<number, SourceProblemReason>> = {
    403: "private",
    404: "not_found",
  };
  if (status < 500 && /private/i.test(message)) reasons[status] = "private";
  return sourceErrorFromHttp(error, reasons, (reason) =>
    reason === "private"
      ? `This MDBList list is private: ${detail}`
      : `MDBList list not found: ${detail}`,
  );
}

async function mdblistRequest(
  connection: ConnectionAccess,
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ data: unknown; response: Response }> {
  const method = options.method ?? "GET";
  const token = await connectionToken(connection);
  const limiters = limitersFor(connection);
  try {
    return await providerFetchJson<unknown>(`${API}${path}`, {
      method,
      query: options.params,
      headers: { Accept: "application/json" },
      bearer: token,
      json: options.body,
      limiter: method === "GET" ? limiters.read : limiters.write,
    });
  } catch (error) {
    throw toSourceError(error);
  }
}

/**
 * Read every item of a list endpoint. With `unified=true` MDBList returns a
 * bare array in list order and gives the next page in `X-Next-Cursor`.
 */
function readAllItems(
  connection: ConnectionAccess,
  path: string,
): Promise<PagedRead<MdblistItem>> {
  return readPages({
    maxPages: MAX_PAGES,
    first: null as string | null,
    async page(cursor) {
      const params: Record<string, string> = {
        unified: "true",
        limit: String(PAGE_SIZE),
      };
      if (cursor) params.cursor = cursor;
      const { data, response } = await mdblistRequest(connection, path, {
        params,
      });
      const next = response.headers.get("X-Next-Cursor");
      const hasMore = response.headers.get("X-Has-More") === "true";
      return {
        items: Array.isArray(data) ? (data as MdblistItem[]) : [],
        next: hasMore && next ? next : null,
      };
    },
  });
}

/** Read every page of a /sync/… snapshot (cursor in `pagination`). */
async function readAllSync(
  connection: ConnectionAccess,
  path: string,
): Promise<SyncPage> {
  const { items: pages } = await readPages({
    maxPages: MAX_PAGES,
    first: null as string | null,
    async page(cursor) {
      const params: Record<string, string> = { limit: String(PAGE_SIZE) };
      if (cursor) params.cursor = cursor;
      const data = (await mdblistRequest(connection, path, { params }))
        .data as SyncPage;
      const next = data.pagination?.next_cursor ?? null;
      return {
        items: [data],
        next: data.pagination?.has_more && next ? next : null,
      };
    },
  });
  return {
    movies: pages.flatMap((page) => page.movies ?? []),
    shows: pages.flatMap((page) => page.shows ?? []),
    episodes: pages.flatMap((page) => page.episodes ?? []),
  };
}

// ---------------------------------------------------------------------------
// Source refs
// ---------------------------------------------------------------------------

/**
 * Source list refs:
 * - `lists/{id}`: any list the user can see, by numeric ID (stored form).
 * - `lists/{user}/{slug}`: the same, as pasted from a link (normalized to
 *   `lists/{id}` on validation).
 * - `me/watchlist`: the connected user's watchlist.
 * - `me/lists/{id}`: one of the connected user's own lists.
 * - `me/external/{id}`: a list that MDBList imports for the user from IMDb,
 *   Trakt, Letterboxd, JustWatch and others.
 * - `watchlist/{user}`: a pasted watchlist link; only the connected user's
 *   own watchlist can be read (normalized to `me/watchlist`).
 */
type ParsedRef =
  | { kind: "watchlist" }
  | { kind: "list"; id: string }
  | { kind: "list-by-slug"; user: string; slug: string }
  | { kind: "external"; id: string }
  | { kind: "user-watchlist"; user: string };

const NUMERIC = /^\d+$/;

function parseRef(ref: string): ParsedRef | null {
  const parts = ref.split("/");
  if (ref === "me/watchlist") return { kind: "watchlist" };
  if (parts[0] === "me" && parts.length === 3 && NUMERIC.test(parts[2])) {
    if (parts[1] === "lists") return { kind: "list", id: parts[2] };
    if (parts[1] === "external") return { kind: "external", id: parts[2] };
  }
  if (parts[0] === "lists" && parts.length === 2 && NUMERIC.test(parts[1])) {
    return { kind: "list", id: parts[1] };
  }
  if (parts[0] === "lists" && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: "list-by-slug", user: parts[1], slug: parts[2] };
  }
  if (parts[0] === "watchlist" && parts.length === 2 && parts[1]) {
    return { kind: "user-watchlist", user: parts[1] };
  }
  return null;
}

function itemsPath(parsed: ParsedRef): string | null {
  switch (parsed.kind) {
    case "watchlist":
      return "/watchlist/items";
    case "list":
      return `/lists/${parsed.id}/items`;
    case "list-by-slug":
      return `/lists/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.slug)}/items`;
    case "external":
      return `/external/lists/${parsed.id}/items`;
    case "user-watchlist":
      return null;
  }
}

function displayModeFor(mediatype: string | null | undefined): DisplayMode {
  if (mediatype === "movie") return "movie";
  if (mediatype === "show") return "series";
  return "split";
}

/** MDBList answers list info as an object or as a one-item array. */
function firstInfo<T>(data: T | T[] | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

function needsConnection(): SourceValidation {
  return {
    ok: false,
    reason: "needs_connection",
    message: "Connect MDBList to add this list",
  };
}

function isSameUser(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function imdbIdOf(
  ids: MdblistIds | null | undefined,
  fallback?: string | null,
) {
  return asImdbId(ids?.imdb ?? fallback);
}

function toEntry(item: MdblistItem): SourceEntry | null {
  const type =
    item.mediatype === "movie"
      ? "movie"
      : item.mediatype === "show"
        ? "series"
        : null;
  // Seasons and episodes in a list are not Titles.
  if (!type) return null;
  const tmdbId = item.ids?.tmdb ?? item.id;
  const entry: SourceEntry = { type };
  const imdbId = imdbIdOf(item.ids, item.imdb_id);
  if (imdbId) entry.imdbId = imdbId;
  if (typeof tmdbId === "number" && tmdbId > 0) {
    entry.externalIds = { tmdb: { id: tmdbId, type } };
  }
  if (typeof item.ids?.tvdb === "number") {
    entry.externalIds = { ...entry.externalIds, tvdb: item.ids.tvdb };
  }
  if (item.title) entry.title = item.title;
  if (typeof item.release_year === "number") entry.year = item.release_year;
  // For shows MDBList gives the total runtime of all episodes.
  if (
    type === "movie" &&
    typeof item.runtime === "number" &&
    item.runtime > 0
  ) {
    entry.runtimeMinutes = item.runtime;
  }
  return entry;
}

/**
 * MDBList returns the watchlist newest first. The canonical order is oldest
 * added first.
 */
function watchlistOrder(items: MdblistItem[]): MdblistItem[] {
  const oldestFirst = [...items].reverse();
  const time = (item: MdblistItem) =>
    item.watchlist_at ? Date.parse(item.watchlist_at) : Number.NaN;
  if (oldestFirst.every((item) => Number.isFinite(time(item)))) {
    oldestFirst.sort((a, b) => time(a) - time(b));
  }
  return oldestFirst;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Bucket = "movies" | "shows";

function bucketOf(target: ActionTarget): Bucket {
  return target.type === "movie" ? "movies" : "shows";
}

/** Sum of the `not_found` counts (numbers or arrays, per media type). */
function notFoundCount(result: unknown): number {
  const notFound = (result as { not_found?: unknown } | null)?.not_found;
  if (!notFound || typeof notFound !== "object") return 0;
  return Object.values(notFound).reduce<number>((sum, value) => {
    if (typeof value === "number") return sum + value;
    if (Array.isArray(value)) return sum + value.length;
    return sum;
  }, 0);
}

function watchedPayload(target: ActionTarget): Record<string, unknown[]> {
  const ids = { imdb: target.imdbId };
  if (target.type === "series" && target.episode) {
    return {
      shows: [
        {
          ids,
          seasons: [
            {
              number: target.episode.season,
              episodes: [{ number: target.episode.episode }],
            },
          ],
        },
      ],
    };
  }
  return { [bucketOf(target)]: [{ ids }] };
}

async function perform(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
): Promise<void> {
  const ids = { imdb: target.imdbId };
  const bucket = bucketOf(target);
  let path: string;
  let body: Record<string, unknown[]>;
  // Removing something that is already gone is not an error.
  let mustExist: boolean;

  if (intent.kind === "watchlist") {
    path = intent.add ? "/watchlist/items/add" : "/watchlist/items/remove";
    body = { [bucket]: [{ ids }] };
    mustExist = intent.add;
  } else if (intent.kind === "watched") {
    path = intent.add ? "/sync/watched" : "/sync/watched/remove";
    body = watchedPayload(target);
    mustExist = intent.add;
  } else if (intent.rating === null) {
    path = "/sync/ratings/remove";
    body = { [bucket]: [{ ids }] };
    mustExist = false;
  } else {
    const rating = Math.round(intent.rating);
    if (rating < 1 || rating > 10) {
      throw new Error(`MDBList ratings go from 1 to 10, got ${intent.rating}`);
    }
    path = "/sync/ratings";
    body = { [bucket]: [{ ids, rating }] };
    mustExist = true;
  }

  const { data } = await mdblistRequest(connection, path, {
    method: "POST",
    body,
  });
  if (mustExist && notFoundCount(data) > 0) {
    throw new Error(`MDBList does not know ${target.imdbId}`);
  }
}

function validRating(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rating = Math.round(value);
  return rating >= 1 && rating <= 10 ? rating : null;
}

async function getMembership(
  connection: ConnectionAccess,
): Promise<Membership> {
  const [watchlistItems, watched, rated] = await Promise.all([
    readAllItems(connection, "/watchlist/items").then((read) => read.items),
    readAllSync(connection, "/sync/watched"),
    readAllSync(connection, "/sync/ratings"),
  ]);

  const watchlist = watchlistItems.flatMap((item) => {
    const id = imdbIdOf(item.ids, item.imdb_id);
    return id ? [id] : [];
  });

  const watchedIds = new Set<string>();
  for (const row of watched.movies ?? []) {
    const id = imdbIdOf(row.movie?.ids);
    if (id) watchedIds.add(id);
  }
  // MDBList lists a show here as soon as one episode is watched.
  for (const row of watched.shows ?? []) {
    const id = imdbIdOf(row.show?.ids);
    if (id) watchedIds.add(id);
  }
  const watchedEpisodes: string[] = [];
  for (const row of watched.episodes ?? []) {
    const episode = row.episode;
    const id = imdbIdOf(episode?.show?.ids);
    if (
      id &&
      Number.isInteger(episode?.season) &&
      Number.isInteger(episode?.number)
    ) {
      watchedEpisodes.push(`${id}:${episode?.season}:${episode?.number}`);
      watchedIds.add(id);
    }
  }

  const ratings: Record<string, number> = {};
  for (const row of rated.movies ?? []) {
    const id = imdbIdOf(row.movie?.ids);
    const rating = validRating(row.rating);
    if (id && rating !== null) ratings[id] = rating;
  }
  for (const row of rated.shows ?? []) {
    const id = imdbIdOf(row.show?.ids);
    const rating = validRating(row.rating);
    if (id && rating !== null) ratings[id] = rating;
  }

  return {
    watchlist: [...new Set(watchlist)],
    watched: [...watchedIds],
    watchedEpisodes: [...new Set(watchedEpisodes)],
    ratings,
  };
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const client = oauthClient("MDBLIST");

async function fetchUsername(token: string): Promise<string | null> {
  const response = await providerFetch(`${API}/user`, {
    headers: { Accept: "application/json" },
    bearer: token,
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { username?: string | null };
  if (!user.username) return null;
  return user.username;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

async function validateSource(
  ref: string,
  ctx: ProviderContext,
): Promise<SourceValidation> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, reason: "not_found" };
  const connection = ctx.connection;
  if (!connection) return needsConnection();

  try {
    switch (parsed.kind) {
      case "watchlist":
        return {
          ok: true,
          ref: "me/watchlist",
          suggestedTitle: "MDBList watchlist",
          defaultDisplayMode: "split",
        };
      case "user-watchlist":
        // MDBList has no API for another user's watchlist.
        return isSameUser(connection.username, parsed.user)
          ? {
              ok: true,
              ref: "me/watchlist",
              suggestedTitle: "MDBList watchlist",
              defaultDisplayMode: "split",
            }
          : {
              ok: false,
              reason: "private",
              message:
                "MDBList only shares the watchlist of the connected user",
            };
      case "external": {
        const { data } = await mdblistRequest(
          connection,
          `/external/lists/${parsed.id}`,
        );
        const info = firstInfo(data as ListInfoResponse);
        if (!info) return { ok: false, reason: "not_found" };
        return {
          ok: true,
          ref: `me/external/${parsed.id}`,
          suggestedTitle: info.name,
          defaultDisplayMode: displayModeFor(info.mediatype),
        };
      }
      case "list":
      case "list-by-slug": {
        const path =
          parsed.kind === "list"
            ? `/lists/${parsed.id}`
            : `/lists/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.slug)}`;
        const { data } = await mdblistRequest(connection, path);
        const info = firstInfo(data as ListInfoResponse);
        if (!info || typeof info.id !== "number") {
          return { ok: false, reason: "not_found" };
        }
        // The numeric ID survives a rename of the list or of its owner.
        const normalized =
          parsed.kind === "list" && ref.startsWith("me/")
            ? ref
            : `lists/${info.id}`;
        return {
          ok: true,
          ref: normalized,
          suggestedTitle: info.name,
          defaultDisplayMode: displayModeFor(info.mediatype),
        };
      }
    }
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      return { ok: false, reason: error.reason, message: error.message };
    }
    throw error;
  }
}

async function fetchSource(
  ref: string,
  ctx: ProviderContext,
): Promise<SourceSnapshot> {
  const parsed = parseRef(ref);
  if (!parsed) {
    throw new SourceUnavailableError("not_found", `Unknown MDBList ref ${ref}`);
  }
  const connection = ctx.connection;
  if (!connection) {
    throw new SourceUnavailableError(
      "needs_connection",
      "MDBList lists need a Connection",
    );
  }
  let path = itemsPath(parsed);
  if (parsed.kind === "user-watchlist") {
    if (!isSameUser(connection.username, parsed.user)) {
      throw new SourceUnavailableError(
        "private",
        "MDBList only shares the watchlist of the connected user",
      );
    }
    path = "/watchlist/items";
  }
  if (!path) {
    throw new SourceUnavailableError("not_found", `Unknown MDBList ref ${ref}`);
  }

  const { items, complete } = await readAllItems(connection, path);
  const ordered = path === "/watchlist/items" ? watchlistOrder(items) : items;
  return {
    entries: ordered.flatMap((item) => {
      const entry = toEntry(item);
      if (entry && path === "/watchlist/items" && item.watchlist_at) {
        entry.addedAt = item.watchlist_at;
      }
      return entry ? [entry] : [];
    }),
    complete,
  };
}

function asSummaries(data: unknown): MdblistUserListSummary[] {
  return Array.isArray(data) ? (data as MdblistUserListSummary[]) : [];
}

/**
 * The connected user's own lists and external lists, as Source lists the
 * configure page can offer after the user connects MDBList.
 */
export async function listMdblistUserSources(
  connection: ConnectionAccess,
): Promise<ConnectionSource[]> {
  const [lists, external] = await Promise.all([
    mdblistRequest(connection, "/lists/user"),
    mdblistRequest(connection, "/external/lists/user"),
  ]);
  const toSource = (
    prefix: string,
    list: MdblistUserListSummary,
  ): ConnectionSource[] =>
    typeof list.id === "number"
      ? [
          {
            ref: `${prefix}/${list.id}`,
            kind: "list",
            label: list.name?.trim() ? list.name.trim() : `List ${list.id}`,
            defaultDisplayMode: displayModeFor(list.mediatype),
          },
        ]
      : [];
  return [
    ...asSummaries(lists.data).flatMap((list) => toSource("me/lists", list)),
    ...asSummaries(external.data).flatMap((list) =>
      toSource("me/external", list),
    ),
  ];
}

/**
 * MDBList: every Source list reads through the user's Connection (OAuth, a
 * confidential web app with PKCE), so the requests count on the user's own
 * MDBList quota. There is no app-level API key.
 */
export const mdblistProvider: ProviderAdapter = {
  id: "mdblist",
  freshnessMs: 60 * 60_000,
  validateSource,
  fetchSource,
  listConnectionSources: listMdblistUserSources,

  resolutionKey(entry) {
    const tmdb = entry.externalIds?.tmdb;
    if (!tmdb) return null;
    return {
      namespace: tmdb.type === "movie" ? "mdblist-movie" : "mdblist-show",
      externalId: String(tmdb.id),
    };
  },
  resolverStrategies: [tmdbExternalIdsStrategy],

  actions: {
    kinds: ["watchlist", "watched", "rating"],
    getMembership,
    perform,
    affectedSources(intent) {
      return intent.kind === "watchlist" ? ["me/watchlist"] : [];
    },
  },

  oauth: {
    authorizeUrl: "https://mdblist.com/oauth/authorize/",
    tokenUrl: `${API}/oauth/token/`,
    ...client,
    scopes: ["write"],
    revoke: (token) => revokeToken(`${API}/oauth/revoke_token/`, token, client),
    fetchUsername,
  },
};
