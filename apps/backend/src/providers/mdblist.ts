import { asImdbId } from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { ConnectionSource } from "@stremlist/shared/providers";
import { z } from "zod";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import {
  HttpError,
  limitersPerUser,
  providerFetch,
  providerFetchJson,
  RateLimiter,
  sourceErrorFromHttp,
} from "./http";
import { OWN_LIST_FRESHNESS_MS, SHARED_LIST_FRESHNESS_MS } from "./freshness";
import { oauthClient, revokeToken } from "./oauth-app";
import { readPages } from "./paging";
import type { SyncBody } from "./sync-payload";
import {
  bucketOf,
  countNotFound,
  episodeItem,
  syncIds,
  watchedAtOf,
} from "./sync-payload";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  ProviderAdapter,
  ProviderContext,
  SourceEntry,
  SourceValidation,
} from "./types";
import {
  SourceUnavailableError,
  targetEpisodes,
  UnknownTitleError,
} from "./types";

const API = "https://api.mdblist.com";
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

const WINDOW_MS = 5 * 60_000;
const READS_PER_WINDOW = 900;
const WRITES_PER_WINDOW = 270;
const MAX_TRACKED_USERS = 500;

const limitersFor = limitersPerUser(
  () => ({
    read: new RateLimiter(READS_PER_WINDOW, WINDOW_MS),
    write: new RateLimiter(WRITES_PER_WINDOW, WINDOW_MS),
  }),
  MAX_TRACKED_USERS,
);

const mdblistIdsSchema = z.object({
  mdblist: z.unknown().optional(),
  imdb: z.string().nullish(),
  tmdb: z.number().nullish(),
});
type MdblistIds = z.infer<typeof mdblistIdsSchema>;

const mdblistItemSchema = z.object({
  id: z.number().nullish(),
  mediatype: z.string().nullish(),
  imdb_id: z.string().nullish(),
  ids: mdblistIdsSchema.nullish(),
  title: z.string().nullish(),
  release_year: z.number().nullish(),
  runtime: z.number().nullish(),
  watchlist_at: z.string().nullish(),
});
type MdblistItem = z.infer<typeof mdblistItemSchema>;

const mdblistListInfoSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  mediatype: z.string().nullish(),
});
type MdblistListInfo = z.infer<typeof mdblistListInfoSchema>;

const listInfoResponseSchema = z
  .union([mdblistListInfoSchema, z.array(mdblistListInfoSchema)])
  .nullable();

const syncMediaSchema = z.object({
  ids: mdblistIdsSchema.nullish(),
  title: z.string().nullish(),
  year: z.number().nullish(),
});
type SyncMedia = z.infer<typeof syncMediaSchema>;

const syncEpisodeSchema = z.object({
  season: z.number().optional(),
  number: z.number().optional(),
  show: syncMediaSchema.nullish(),
});

const syncRowFields = {
  rating: z.number().nullish(),
  rated_at: z.string().nullish(),
  last_watched_at: z.string().nullish(),
  collected_at: z.string().nullish(),
};

const syncPageSchema = z.object({
  movies: z
    .array(z.object({ movie: syncMediaSchema.nullish(), ...syncRowFields }))
    .optional(),
  shows: z
    .array(z.object({ show: syncMediaSchema.nullish(), ...syncRowFields }))
    .optional(),
  episodes: z
    .array(
      z.object({
        episode: syncEpisodeSchema.nullish(),
        collected_at: z.string().nullish(),
      }),
    )
    .optional(),
  seasons: z
    .array(
      z.object({
        season: z.object({ show: syncMediaSchema.nullish() }).nullish(),
        last_watched_at: z.string().nullish(),
      }),
    )
    .optional(),
  pagination: z
    .object({
      has_more: z.boolean().optional(),
      next_cursor: z.string().nullish(),
    })
    .optional(),
});
type SyncPage = z.infer<typeof syncPageSchema>;

const mdblistUserSchema = z.object({ username: z.string().nullish() });

const upNextPageSchema = z.object({
  items: z
    .array(
      z.object({
        show: syncMediaSchema.nullish(),
        last_watched_at: z.string().nullish(),
      }),
    )
    .optional(),
  has_more: z.boolean().optional(),
});

const recommendedSectionSchema = z.object({
  slug: z.string().optional(),
  label: z.string().optional(),
});
const recommendedSectionsSchema = z.object({
  sections: z.array(recommendedSectionSchema).optional(),
});

const mdblistErrorSchema = z
  .object({ error: z.unknown().optional() })
  .partial()
  .nullable();

function throwSourceError(error: unknown): never {
  if (!(error instanceof HttpError)) throw error;
  let message = "";
  try {
    const parsed: unknown = JSON.parse(error.body);
    const body = mdblistErrorSchema.safeParse(parsed);
    message =
      body.success && typeof body.data?.error === "string"
        ? body.data.error
        : "";
  } catch {
    message = error.body.slice(0, 200);
  }
  const { status } = error;
  const detail = message || status;
  if (status === 401 || (status === 403 && /token/i.test(message))) {
    throw new SourceUnavailableError(
      "needs_connection",
      `MDBList refused the Connection: ${detail}`,
    );
  }
  if (status === 403 && /supporter/i.test(message)) {
    throw new SourceUnavailableError(
      "premium_only",
      `MDBList needs a supporter plan: ${detail}`,
    );
  }
  const reasons = {
    403: "private",
    404: "not_found",
    ...(status < 500 && /private/i.test(message)
      ? { [status]: "private" }
      : {}),
  } as const;
  throw sourceErrorFromHttp(error, reasons, (reason) =>
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
) {
  const method = options.method ?? "GET";
  const token = await connection.getAccessToken();
  const limiters = limitersFor(connection);
  try {
    return await providerFetchJson(`${API}${path}`, {
      method,
      query: options.params,
      headers: { Accept: "application/json" },
      bearer: token,
      json: options.body,
      limiter: method === "GET" ? limiters.read : limiters.write,
    });
  } catch (error) {
    throwSourceError(error);
  }
}

function readAllItems(connection: ConnectionAccess, path: string) {
  return readPages({
    maxPages: MAX_PAGES,
    first: null as string | null,
    async page(cursor) {
      const { data, response } = await mdblistRequest(connection, path, {
        params: {
          unified: "true",
          limit: String(PAGE_SIZE),
          ...(cursor ? { cursor } : {}),
        },
      });
      const next = response.headers.get("X-Next-Cursor");
      const hasMore = response.headers.get("X-Has-More") === "true";
      return {
        items: Array.isArray(data)
          ? z.array(mdblistItemSchema).parse(data)
          : [],
        next: hasMore && next ? next : null,
      };
    },
  });
}

async function readAllSync(
  connection: ConnectionAccess,
  path: string,
  params: Record<string, string> = {},
) {
  const { items: pages, complete } = await readPages({
    maxPages: MAX_PAGES,
    first: null as string | null,
    async page(cursor) {
      const { data: page } = await mdblistRequest(connection, path, {
        params: {
          ...params,
          limit: String(PAGE_SIZE),
          ...(cursor ? { cursor } : {}),
        },
      });
      const data = syncPageSchema.parse(page);
      const next = data.pagination?.next_cursor ?? null;
      return {
        items: [data],
        next: data.pagination?.has_more && next ? next : null,
      };
    },
  });
  return {
    sync: {
      movies: pages.flatMap((page) => page.movies ?? []),
      shows: pages.flatMap((page) => page.shows ?? []),
      episodes: pages.flatMap((page) => page.episodes ?? []),
      seasons: pages.flatMap((page) => page.seasons ?? []),
    },
    complete,
  };
}

type ParsedRef =
  | { kind: "watchlist" }
  | { kind: "list"; id: string }
  | { kind: "list-by-slug"; user: string; slug: string }
  | { kind: "external"; id: string }
  | { kind: "user-watchlist"; user: string }
  | { kind: "ratings" }
  | { kind: "history" }
  | { kind: "collection" }
  | { kind: "up-next" }
  | { kind: "official"; slug: string }
  | { kind: "recommended"; section: string };

const NUMERIC = /^\d+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function parseRef(ref: string) {
  const parts = ref.split("/");
  if (ref === "me/watchlist") return { kind: "watchlist" } satisfies ParsedRef;
  if (ref === "me/ratings") return { kind: "ratings" } satisfies ParsedRef;
  if (ref === "me/history") return { kind: "history" } satisfies ParsedRef;
  if (ref === "me/collection")
    return { kind: "collection" } satisfies ParsedRef;
  if (ref === "me/up-next") return { kind: "up-next" } satisfies ParsedRef;
  if (parts.length === 2 && SLUG.test(parts[1])) {
    if (parts[0] === "official")
      return { kind: "official", slug: parts[1] } satisfies ParsedRef;
    if (parts[0] === "recommended") {
      return { kind: "recommended", section: parts[1] } satisfies ParsedRef;
    }
  }
  if (parts[0] === "me" && parts.length === 3 && NUMERIC.test(parts[2])) {
    if (parts[1] === "lists")
      return { kind: "list", id: parts[2] } satisfies ParsedRef;
    if (parts[1] === "external")
      return { kind: "external", id: parts[2] } satisfies ParsedRef;
  }
  if (parts[0] === "lists" && parts.length === 2 && NUMERIC.test(parts[1])) {
    return { kind: "list", id: parts[1] } satisfies ParsedRef;
  }
  if (parts[0] === "lists" && parts.length === 3 && parts[1] && parts[2]) {
    return {
      kind: "list-by-slug",
      user: parts[1],
      slug: parts[2],
    } satisfies ParsedRef;
  }
  if (parts[0] === "watchlist" && parts.length === 2 && parts[1]) {
    return { kind: "user-watchlist", user: parts[1] } satisfies ParsedRef;
  }
  return null;
}

type ItemsRef = Exclude<
  ParsedRef,
  { kind: "ratings" | "history" | "collection" | "up-next" }
>;

function itemsPath(parsed: ItemsRef) {
  switch (parsed.kind) {
    case "official":
      return `/lists/official/${parsed.slug}/items`;
    case "recommended":
      return `/lists/recommended/${parsed.section}/items`;
    case "watchlist":
    case "user-watchlist":
      return "/watchlist/items";
    case "list":
      return `/lists/${parsed.id}/items`;
    case "list-by-slug":
      return `/lists/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.slug)}/items`;
    case "external":
      return `/external/lists/${parsed.id}/items`;
  }
}

function displayModeFor(mediatype: string | null | undefined) {
  const mode: DisplayMode =
    mediatype === "movie" ? "movie" : mediatype === "show" ? "series" : "split";
  return mode;
}

function firstInfo<T>(data: T | T[] | null) {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

function isSameUser(a: string | null | undefined, b: string) {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

function imdbIdOf(
  ids: MdblistIds | null | undefined,
  fallback?: string | null,
) {
  return asImdbId(ids?.imdb ?? fallback);
}

function toEntry(item: MdblistItem) {
  const type =
    item.mediatype === "movie"
      ? "movie"
      : item.mediatype === "show"
        ? "series"
        : null;
  if (!type) return null;
  const tmdbId = item.ids?.tmdb ?? item.id;
  const entry: SourceEntry = { type };
  const imdbId = imdbIdOf(item.ids, item.imdb_id);
  if (imdbId) entry.imdbId = imdbId;
  if (typeof tmdbId === "number" && tmdbId > 0) {
    entry.externalIds = { tmdb: { id: tmdbId, type } };
  }
  if (item.title) entry.title = item.title;
  if (typeof item.release_year === "number") entry.year = item.release_year;
  if (
    type === "movie" &&
    typeof item.runtime === "number" &&
    item.runtime > 0
  ) {
    entry.runtimeMinutes = item.runtime;
  }
  return entry;
}

function watchlistOrder(items: MdblistItem[]) {
  const oldestFirst = [...items].reverse();
  const time = (item: MdblistItem) =>
    item.watchlist_at ? Date.parse(item.watchlist_at) : Number.NaN;
  if (oldestFirst.every((item) => Number.isFinite(time(item)))) {
    oldestFirst.sort((a, b) => time(a) - time(b));
  }
  return oldestFirst;
}

type SyncRowDates = z.infer<z.ZodObject<typeof syncRowFields>>;

function syncMediaEntry(
  media: SyncMedia | null | undefined,
  type: "movie" | "series",
) {
  if (!media) return null;
  const entry: SourceEntry = { type };
  const imdbId = imdbIdOf(media.ids);
  if (imdbId) entry.imdbId = imdbId;
  const tmdbId = media.ids?.tmdb;
  if (typeof tmdbId === "number" && tmdbId > 0) {
    entry.externalIds = { tmdb: { id: tmdbId, type } };
  }
  if (media.title) entry.title = media.title;
  if (typeof media.year === "number") entry.year = media.year;
  return entry;
}

function syncEntries(
  sync: SyncPage,
  dateOf: (row: SyncRowDates) => string | null | undefined,
  { dated = true }: { dated?: boolean } = {},
) {
  const rows = [
    ...(sync.movies ?? []).map((row) => ({
      entry: syncMediaEntry(row.movie, "movie"),
      at: dateOf(row),
    })),
    ...(sync.shows ?? []).map((row) => ({
      entry: syncMediaEntry(row.show, "series"),
      at: dateOf(row),
    })),
  ];
  const time = (at: string | null | undefined) => {
    const parsed = at ? Date.parse(at) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return rows
    .map((row, index) => ({ ...row, index, time: time(row.at) }))
    .sort((a, b) =>
      a.time === b.time ? a.index - b.index : a.time < b.time ? -1 : 1,
    )
    .flatMap(({ entry, at }) => {
      if (!entry) return [];
      return [at && dated ? { ...entry, addedAt: at } : entry];
    });
}

async function readSyncSource(
  connection: ConnectionAccess,
  kind: "ratings" | "history",
) {
  if (kind === "ratings") {
    const { sync, complete } = await readAllSync(connection, "/sync/ratings");
    return { entries: syncEntries(sync, (row) => row.rated_at), complete };
  }
  const [movies, seasons] = await Promise.all(
    ["movie", "season"].map((mediatype) =>
      readAllSync(connection, "/sync/watched", { mediatype }),
    ),
  );
  const shows = onePerShow(
    (seasons.sync.seasons ?? []).map((row) => ({
      show: row.season?.show,
      at: row.last_watched_at,
    })),
    "latest",
  );
  return {
    entries: syncEntries(
      {
        movies: movies.sync.movies,
        shows: shows.map(({ show, at }) => ({ show, last_watched_at: at })),
      },
      (row) => row.last_watched_at,
    ),
    complete: movies.complete && seasons.complete,
  };
}

async function readCollection(connection: ConnectionAccess) {
  const [movies, shows, episodes] = await Promise.all(
    ["movie", "show", "episode"].map((mediatype) =>
      readAllSync(connection, "/sync/collection", { mediatype }),
    ),
  );
  const collectedShows = onePerShow(
    [
      ...(shows.sync.shows ?? []).map((row) => ({
        show: row.show,
        at: row.collected_at,
      })),
      ...(episodes.sync.episodes ?? []).map((row) => ({
        show: row.episode?.show,
        at: row.collected_at,
      })),
    ],
    "earliest",
  );
  return {
    entries: syncEntries(
      {
        movies: movies.sync.movies,
        shows: collectedShows.map(({ show, at }) => ({
          show,
          collected_at: at,
        })),
      },
      (row) => row.collected_at,
    ),
    complete: movies.complete && shows.complete && episodes.complete,
  };
}

type DatedShow = { show: SyncMedia; at: string | null | undefined };

function onePerShow(
  rows: { show?: SyncMedia | null; at?: string | null }[],
  keep: "latest" | "earliest",
) {
  const shows = new Map<string, DatedShow>();
  for (const { show, at } of rows) {
    const key = show?.ids?.imdb ?? show?.ids?.tmdb;
    if (!show || key == null) continue;
    const seen = shows.get(String(key));
    const better =
      !!at && (!seen?.at || (keep === "latest" ? at > seen.at : at < seen.at));
    if (!seen || better) shows.set(String(key), { show, at });
  }
  return [...shows.values()];
}

const UP_NEXT_PAGE_SIZE = 100;
const MAX_UP_NEXT_PAGES = 10;

async function readUpNext(connection: ConnectionAccess) {
  const { items, complete } = await readPages({
    maxPages: MAX_UP_NEXT_PAGES,
    first: 0,
    async page(offset) {
      const { data } = await mdblistRequest(connection, "/upnext", {
        params: { limit: String(UP_NEXT_PAGE_SIZE), offset: String(offset) },
      });
      const page = upNextPageSchema.parse(data);
      const rows = page.items ?? [];
      return {
        items: rows,
        next: page.has_more && rows.length > 0 ? offset + rows.length : null,
      };
    },
  });
  return {
    entries: syncEntries({ shows: items }, (row) => row.last_watched_at, {
      dated: false,
    }),
    complete,
  };
}

function watchedPayload(intent: ActionIntent, target: ActionTarget) {
  const at = watchedAtOf(intent);
  const episodes = targetEpisodes(target);
  if (target.type === "series" && episodes.length > 0) {
    return { shows: [episodeItem(target, episodes, at.watched_at)] };
  }
  return { [bucketOf(target)]: [{ ids: syncIds(target), ...at }] };
}

async function perform(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
) {
  const ids = syncIds(target);
  const bucket = bucketOf(target);
  let path: string;
  let body: SyncBody;
  let mustExist: boolean;

  if (intent.kind === "watchlist") {
    path = intent.add ? "/watchlist/items/add" : "/watchlist/items/remove";
    body = { [bucket]: [{ ids }] };
    mustExist = intent.add;
  } else if (intent.kind === "watched") {
    path = intent.add ? "/sync/watched" : "/sync/watched/remove";
    body = watchedPayload(intent, target);
    mustExist = intent.add;
  } else if (intent.rating === null) {
    path = "/sync/ratings/remove";
    body = { [bucket]: [{ ids }] };
    mustExist = false;
  } else {
    path = "/sync/ratings";
    body = { [bucket]: [{ ids, rating: intent.rating }] };
    mustExist = true;
  }

  const { data } = await mdblistRequest(connection, path, {
    method: "POST",
    body,
  });
  if (mustExist && countNotFound(data) > 0) {
    throw new UnknownTitleError("mdblist", target.imdbId);
  }
}

function validRating(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rating = Math.round(value);
  return rating >= 1 && rating <= 10 ? rating : null;
}

async function getMembership(connection: ConnectionAccess) {
  const [watchlistItems, watched, rated] = await Promise.all([
    readAllItems(connection, "/watchlist/items").then((read) => read.items),
    readAllSync(connection, "/sync/watched").then((read) => read.sync),
    readAllSync(connection, "/sync/ratings").then((read) => read.sync),
  ]);

  const watchlist = watchlistItems.flatMap((item) => {
    const id = imdbIdOf(item.ids, item.imdb_id);
    return id ? [id] : [];
  });

  const watchedIds = new Set<string>();
  for (const ids of [
    ...(watched.movies ?? []).map((row) => row.movie?.ids),
    ...(watched.shows ?? []).map((row) => row.show?.ids),
  ]) {
    const id = imdbIdOf(ids);
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
  for (const [ids, value] of [
    ...(rated.movies ?? []).map((row) => [row.movie?.ids, row.rating] as const),
    ...(rated.shows ?? []).map((row) => [row.show?.ids, row.rating] as const),
  ]) {
    const id = imdbIdOf(ids);
    const rating = validRating(value);
    if (id && rating !== null) ratings[id] = rating;
  }

  return {
    watchlist: [...new Set(watchlist)],
    watched: [...watchedIds],
    watchedEpisodes: [...new Set(watchedEpisodes)],
    ratings,
  };
}

const client = oauthClient("MDBLIST");

async function fetchUsername(token: string) {
  const response = await providerFetch(`${API}/user`, {
    headers: { Accept: "application/json" },
    bearer: token,
  });
  if (!response.ok) return null;
  const user = mdblistUserSchema.parse(await response.json());
  if (!user.username) return null;
  return user.username;
}

async function validateSource(ref: string, ctx: ProviderContext) {
  const parsed = parseRef(ref);
  if (!parsed)
    return { ok: false, reason: "not_found" } satisfies SourceValidation;
  const connection = ctx.connection;
  if (!connection)
    return { ok: false, reason: "needs_connection" } satisfies SourceValidation;

  switch (parsed.kind) {
    case "watchlist":
    case "user-watchlist":
      if (
        parsed.kind === "user-watchlist" &&
        !isSameUser(connection.username, parsed.user)
      ) {
        return { ok: false, reason: "private" } satisfies SourceValidation;
      }
      return {
        ok: true,
        ref: "me/watchlist",
        suggestedTitle: "MDBList watchlist",
        defaultDisplayMode: "split",
      } satisfies SourceValidation;
    case "ratings":
    case "history":
    case "collection":
      return {
        ok: true,
        ref,
        suggestedTitle: `MDBList ${parsed.kind}`,
        defaultDisplayMode: "split",
      } satisfies SourceValidation;
    case "up-next":
      return {
        ok: true,
        ref,
        suggestedTitle: "MDBList Up Next",
        defaultDisplayMode: "series",
      } satisfies SourceValidation;
    case "recommended": {
      const { data } = await mdblistRequest(
        connection,
        `/lists/recommended/${parsed.section}`,
      );
      const section = recommendedSectionSchema.parse(data);
      return {
        ok: true,
        ref,
        suggestedTitle: section.label?.trim() || "MDBList recommendations",
        defaultDisplayMode: "split",
      } satisfies SourceValidation;
    }
    case "official": {
      const { data } = await mdblistRequest(
        connection,
        `/lists/official/${parsed.slug}`,
      );
      const info = firstInfo(listInfoResponseSchema.parse(data));
      if (!info)
        return { ok: false, reason: "not_found" } satisfies SourceValidation;
      return {
        ok: true,
        ref,
        suggestedTitle: info.name,
        defaultDisplayMode: displayModeFor(info.mediatype),
      } satisfies SourceValidation;
    }
    case "external": {
      const { data } = await mdblistRequest(
        connection,
        `/external/lists/${parsed.id}`,
      );
      const info = firstInfo(listInfoResponseSchema.parse(data));
      if (!info)
        return { ok: false, reason: "not_found" } satisfies SourceValidation;
      return {
        ok: true,
        ref: `me/external/${parsed.id}`,
        suggestedTitle: info.name,
        defaultDisplayMode: displayModeFor(info.mediatype),
      } satisfies SourceValidation;
    }
    case "list":
    case "list-by-slug": {
      const path =
        parsed.kind === "list"
          ? `/lists/${parsed.id}`
          : `/lists/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.slug)}`;
      const { data } = await mdblistRequest(connection, path);
      const info = firstInfo(listInfoResponseSchema.parse(data));
      if (!info || typeof info.id !== "number") {
        return { ok: false, reason: "not_found" } satisfies SourceValidation;
      }
      const normalized =
        parsed.kind === "list" && ref.startsWith("me/")
          ? ref
          : `lists/${info.id}`;
      return {
        ok: true,
        ref: normalized,
        suggestedTitle: info.name,
        defaultDisplayMode: displayModeFor(info.mediatype),
      } satisfies SourceValidation;
    }
  }
}

async function fetchSource(ref: string, ctx: ProviderContext) {
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
  if (
    parsed.kind === "user-watchlist" &&
    !isSameUser(connection.username, parsed.user)
  ) {
    throw new SourceUnavailableError(
      "private",
      "MDBList only shares the watchlist of the connected user",
    );
  }
  if (parsed.kind === "ratings" || parsed.kind === "history") {
    return readSyncSource(connection, parsed.kind);
  }
  if (parsed.kind === "collection") return readCollection(connection);
  if (parsed.kind === "up-next") return readUpNext(connection);
  const path = itemsPath(parsed);

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

function asSummaries(data: unknown) {
  return Array.isArray(data) ? z.array(mdblistListInfoSchema).parse(data) : [];
}

const likedListsPageSchema = z.object({
  lists: z.array(mdblistListInfoSchema).optional(),
  pagination: z.object({ has_more: z.boolean().optional() }).optional(),
});

const LIKED_PAGE_SIZE = 100;
const MAX_LIKED_PAGES = 10;

async function readLikedLists(connection: ConnectionAccess) {
  const { items } = await readPages({
    maxPages: MAX_LIKED_PAGES,
    first: 0,
    async page(offset) {
      const { data } = await mdblistRequest(connection, "/lists/liked", {
        params: { limit: String(LIKED_PAGE_SIZE), offset: String(offset) },
      });
      const page = likedListsPageSchema.parse(data);
      const lists = page.lists ?? [];
      return {
        items: lists,
        next:
          page.pagination?.has_more && lists.length > 0
            ? offset + lists.length
            : null,
      };
    },
  });
  return items;
}

async function readRecommendedSections(connection: ConnectionAccess) {
  const { data } = await mdblistRequest(connection, "/lists/recommended");
  const { sections = [] } = recommendedSectionsSchema.parse(data);
  return sections.flatMap(({ slug, label }) =>
    slug && SLUG.test(slug)
      ? [
          {
            ref: `recommended/${slug}`,
            kind: "recommendations" as const,
            label: label?.trim() || slug,
            defaultDisplayMode: "split" as const,
          },
        ]
      : [],
  );
}

function orNone<T>(what: string, read: Promise<T[]>) {
  return read.catch((error: unknown) => {
    console.error(
      `Listing MDBList ${what} failed:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  });
}

/**
 * The connected user's own lists, external lists, liked lists and
 * recommendation sections, as Source lists the configure page can offer
 * after the user connects MDBList. A liked list reads by its ID, like a
 * pasted list link.
 */
export async function listMdblistUserSources(connection: ConnectionAccess) {
  const [lists, external, liked, recommended] = await Promise.all([
    mdblistRequest(connection, "/lists/user"),
    mdblistRequest(connection, "/external/lists/user"),
    orNone("liked lists", readLikedLists(connection)),
    orNone("recommendation sections", readRecommendedSections(connection)),
  ]);
  const own = asSummaries(lists.data);
  const ownIds = new Set(own.map((list) => list.id));
  const toSource = (prefix: string, list: MdblistListInfo) =>
    typeof list.id === "number"
      ? [
          {
            ref: `${prefix}/${list.id}`,
            kind: "list",
            label: list.name?.trim() ? list.name.trim() : `List ${list.id}`,
            defaultDisplayMode: displayModeFor(list.mediatype),
          } satisfies ConnectionSource,
        ]
      : [];
  return [
    ...own.flatMap((list) => toSource("me/lists", list)),
    ...asSummaries(external.data).flatMap((list) =>
      toSource("me/external", list),
    ),
    ...liked
      .filter((list) => !ownIds.has(list.id))
      .flatMap((list) => toSource("lists", list)),
    ...recommended,
  ];
}

/**
 * MDBList: every Source list reads through the user's Connection (OAuth, a
 * confidential web app with PKCE), so the requests count on the user's own
 * MDBList quota. There is no app-level API key.
 */
export const mdblistProvider: ProviderAdapter = {
  id: "mdblist",
  freshnessMs: SHARED_LIST_FRESHNESS_MS,

  freshnessFor(ref) {
    return ref.startsWith("me/")
      ? OWN_LIST_FRESHNESS_MS
      : SHARED_LIST_FRESHNESS_MS;
  },
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
      switch (intent.kind) {
        case "watchlist":
          return ["me/watchlist"];
        case "watched":
          return ["me/history", "me/up-next"];
        case "rating":
          return ["me/ratings"];
      }
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
