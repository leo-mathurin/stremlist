import type { DisplayMode } from "@stremlist/shared/constants";
import { z } from "zod";
import { HttpError } from "../http";
import type {
  ConnectionAccess,
  PagedRead,
  SourceEntry,
  SourceSnapshot,
  SourceValidation,
} from "../types";
import { SourceUnavailableError } from "../types";
import type { TraktReadOptions } from "./api";
import {
  nonEmpty,
  toSourceError,
  traktGetAll,
  traktGetJson,
  traktGetParsed,
} from "./api";
import type { TraktItem } from "./entries";
import {
  interleave,
  itemToEntry,
  mediaToEntry,
  oldestFirst,
  traktItemSchema,
  traktMediaSchema,
  uniqueEntries,
  withAddedAt,
} from "./entries";

/** Most entries read from one Source list. */
const MAX_SOURCE_ITEMS = 5000;
/** Charts and recommendations: one page per kind is plenty. */
const CHART_ITEMS = 100;
/**
 * A smart list built on Trakt's whole catalog can match thousands of
 * Titles. Its best-ranked ones are enough for a catalog.
 */
const SMART_LIST_ITEMS = 1000;

const TRAKT_CHARTS = [
  "trending",
  "popular",
  "anticipated",
  "boxoffice",
  "watched",
  "played",
  "collected",
  "favorited",
  "recommended",
] as const;
type TraktChart = (typeof TRAKT_CHARTS)[number];
/** Charts that Trakt counts over a period; Stremlist reads the past week. */
const WEEKLY_CHARTS = new Set<TraktChart>([
  "watched",
  "played",
  "collected",
  "favorited",
  "recommended",
]);

/**
 * A Trakt Source list reference, parsed. `user: "me"` reads through the
 * Connection.
 */
export type TraktSource =
  | { kind: "watchlist"; user: string }
  | { kind: "favorites"; user: string }
  | { kind: "ratings"; user: string }
  | { kind: "list"; user: string; list: string }
  | { kind: "shared_list"; id: string }
  /** `user: "me"` is one of the connected user's own, maybe private. */
  | { kind: "smart_list"; user: "me" | null; slug: string }
  | { kind: "chart"; chart: TraktChart }
  | { kind: "recommendations" }
  | { kind: "up_next" }
  | { kind: "history"; user: string }
  | { kind: "collection"; user: string };

const CHARTS: Record<TraktChart, string> = {
  trending: "Trakt Trending",
  popular: "Trakt Popular",
  anticipated: "Trakt Anticipated",
  boxoffice: "Trakt Box Office",
  watched: "Trakt Most Watched",
  played: "Trakt Most Played",
  collected: "Trakt Most Collected",
  favorited: "Trakt Most Favorited",
  recommended: "Trakt Most Recommended",
};

/** Source lists that every Trakt user has, public or through the Connection. */
const USER_SOURCES = [
  "watchlist",
  "favorites",
  "ratings",
  "history",
  "collection",
] as const;
type UserSourceKind = (typeof USER_SOURCES)[number];

function userSourceKind(segment: string | undefined): UserSourceKind | null {
  return USER_SOURCES.find((kind) => kind === segment) ?? null;
}

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseTraktRef(ref: string): TraktSource | null {
  const parts = ref.split("/");
  const chart = TRAKT_CHARTS.find((name) => name === ref);
  if (chart) return { kind: "chart", chart };
  if (parts[0] === "me") {
    if (parts.length === 2) {
      const kind = userSourceKind(parts[1]);
      if (kind) return { kind, user: "me" };
      switch (parts[1]) {
        case "recommendations":
          return { kind: "recommendations" };
        case "up-next":
          return { kind: "up_next" };
      }
    }
    if (parts.length === 3 && parts[1] === "lists" && SEGMENT.test(parts[2])) {
      return { kind: "list", user: "me", list: parts[2] };
    }
    if (
      parts.length === 3 &&
      parts[1] === "smart-lists" &&
      SEGMENT.test(parts[2])
    ) {
      return { kind: "smart_list", user: "me", slug: parts[2].toLowerCase() };
    }
    return null;
  }
  if (parts[0] === "users" && parts[1] && SEGMENT.test(parts[1])) {
    const user = parts[1].toLowerCase();
    const kind = userSourceKind(parts[2]);
    if (parts.length === 3 && kind) return { kind, user };
    if (parts.length === 4 && parts[2] === "lists" && SEGMENT.test(parts[3])) {
      return { kind: "list", user, list: parts[3].toLowerCase() };
    }
    return null;
  }
  if (parts.length === 2 && parts[0] === "lists" && SEGMENT.test(parts[1])) {
    return { kind: "shared_list", id: parts[1].toLowerCase() };
  }
  if (
    parts.length === 2 &&
    parts[0] === "smart-lists" &&
    SEGMENT.test(parts[1])
  ) {
    return { kind: "smart_list", user: null, slug: parts[1].toLowerCase() };
  }
  return null;
}

function sourceToRef(source: TraktSource): string {
  switch (source.kind) {
    case "watchlist":
    case "favorites":
    case "ratings":
    case "history":
    case "collection":
      return source.user === "me"
        ? `me/${source.kind}`
        : `users/${source.user}/${source.kind}`;
    case "list":
      return source.user === "me"
        ? `me/lists/${source.list}`
        : `users/${source.user}/lists/${source.list}`;
    case "shared_list":
      return `lists/${source.id}`;
    case "smart_list":
      return source.user === "me"
        ? `me/smart-lists/${source.slug}`
        : `smart-lists/${source.slug}`;
    case "chart":
      return source.chart;
    case "recommendations":
      return "me/recommendations";
    case "up_next":
      return "me/up-next";
  }
}

export function isPersonal(source: TraktSource): boolean {
  if ("user" in source) return source.user === "me";
  return source.kind === "recommendations" || source.kind === "up_next";
}

function userPath(user: string): string {
  return `/users/${encodeURIComponent(user)}`;
}

function listPath(
  source: TraktSource & { kind: "list" | "shared_list" },
): string {
  return source.kind === "list"
    ? `${userPath(source.user)}/lists/${encodeURIComponent(source.list)}`
    : `/lists/${encodeURIComponent(source.id)}`;
}

function smartListPath(source: TraktSource & { kind: "smart_list" }): string {
  return `/smart-lists/${encodeURIComponent(source.slug)}`;
}

/** The Connection to read through: personal Source lists need one. */
function requireConnection(
  source: TraktSource,
  connection: ConnectionAccess | null,
): ConnectionAccess | null {
  if (isPersonal(source) && !connection) {
    throw new SourceUnavailableError(
      "needs_connection",
      `Trakt ${sourceToRef(source)} needs a Connection`,
    );
  }
  return connection;
}

async function listedEntries(
  path: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceSnapshot> {
  const { items, complete } = await traktGetAll(
    path,
    traktItemSchema,
    connection,
    { ...options, maxItems: MAX_SOURCE_ITEMS },
  );
  return newestRows(items, (item) => item.listed_at, complete);
}

/** The newest MAX_SOURCE_ITEMS rows, oldest first, dated by `date`. */
function newestRows(
  rows: TraktItem[],
  date: (row: TraktItem) => string | null | undefined,
  complete = true,
): SourceSnapshot {
  return {
    entries: oldestFirst(rows, date)
      .slice(-MAX_SOURCE_ITEMS)
      .flatMap((row) => {
        const entry = itemToEntry(row);
        return entry ? [withAddedAt(entry, date(row))] : [];
      }),
    complete: complete && rows.length <= MAX_SOURCE_ITEMS,
  };
}

const rankedRowSchema = traktItemSchema.extend(traktMediaSchema.shape);
type RankedRow = z.infer<typeof rankedRowSchema>;

function rankedPath(
  source: TraktSource & { kind: "chart" | "recommendations" },
  kind: "movies" | "shows",
): string {
  if (source.kind === "recommendations") return `/recommendations/${kind}`;
  return WEEKLY_CHARTS.has(source.chart)
    ? `/${kind}/${source.chart}/weekly`
    : `/${kind}/${source.chart}`;
}

/** Movies and shows interleaved, each in Trakt's rank order. */
async function rankedEntries(
  source: TraktSource & { kind: "chart" | "recommendations" },
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceEntry[]> {
  const read = (kind: "movies" | "shows") =>
    traktGetParsed(
      `${rankedPath(source, kind)}?limit=${CHART_ITEMS}`,
      z.array(rankedRowSchema),
      connection,
      options,
    );
  const [movies, shows] = await Promise.all([
    read("movies"),
    // The box office has only movies.
    source.kind === "chart" && source.chart === "boxoffice"
      ? null
      : read("shows"),
  ]);
  // Popular rows and recommendations are the media itself; the other
  // charts wrap it.
  const toEntry = (row: RankedRow, type: "movie" | "series") =>
    mediaToEntry((type === "movie" ? row.movie : row.show) ?? row, type);
  return interleave(
    (movies ?? []).map((row) => toEntry(row, "movie")),
    (shows ?? []).map((row) => toEntry(row, "series")),
  );
}

/**
 * A smart list in Trakt's rank order. Trakt works its Titles out from the
 * list's filters on each read, so they carry no added date.
 */
async function smartListEntries(
  source: TraktSource & { kind: "smart_list" },
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceSnapshot> {
  const { items, complete } = await traktGetAll(
    `${smartListPath(source)}/items`,
    traktItemSchema,
    connection,
    { ...options, maxItems: SMART_LIST_ITEMS },
  );
  return {
    entries: items.flatMap((item) => {
      const entry = itemToEntry(item);
      return entry ? [entry] : [];
    }),
    complete,
  };
}

/** Shows in progress, oldest watched first (the show, not the next episode). */
async function upNextEntries(
  connection: ConnectionAccess | null,
): Promise<SourceSnapshot> {
  let read: PagedRead<TraktItem>;
  try {
    read = await traktGetAll(
      "/sync/progress/up_next",
      traktItemSchema,
      connection,
      { maxItems: MAX_SOURCE_ITEMS },
    );
  } catch (error) {
    // Up next is a limited-access endpoint for some apps. Watched progress
    // without completed shows gives the same rows.
    if (
      !(error instanceof HttpError) ||
      ![403, 404, 405].includes(error.status)
    ) {
      throw error;
    }
    read = await traktGetAll(
      "/sync/progress/watched?hide_completed=true",
      traktItemSchema,
      connection,
      { maxItems: MAX_SOURCE_ITEMS },
    );
  }
  return {
    entries: oldestFirst(
      read.items,
      (row) => row.progress?.last_watched_at,
    ).flatMap((row) => (row.show ? [mediaToEntry(row.show, "series")] : [])),
    complete: read.complete,
  };
}

/**
 * Every page of a movies read and a shows read, newest MAX_SOURCE_ITEMS
 * rows by `date`. Trakt pages these reads 100 at a time when no limit is
 * given.
 */
async function moviesAndShows(
  moviesPath: string,
  showsPath: string,
  date: (row: TraktItem) => string | null | undefined,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceSnapshot> {
  const read = (path: string) =>
    traktGetAll(path, traktItemSchema, connection, {
      ...options,
      maxItems: MAX_SOURCE_ITEMS,
    });
  const [movies, shows] = await Promise.all([
    read(moviesPath),
    read(showsPath),
  ]);
  return newestRows(
    [...movies.items, ...shows.items],
    date,
    movies.complete && shows.complete,
  );
}

/** Watched movies and shows, by last watch, oldest first. */
function historyEntries(
  user: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceSnapshot> {
  return moviesAndShows(
    `${userPath(user)}/watched/movies`,
    `${userPath(user)}/watched/shows?extended=noseasons`,
    (row) => row.last_watched_at,
    connection,
    options,
  );
}

/** Collected movies and shows, by collection date, oldest first. */
function collectionEntries(
  user: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceSnapshot> {
  // The connected user's own collection reads through /sync; another
  // user's public one through their profile.
  const base =
    user === "me" ? "/sync/collection" : `${userPath(user)}/collection`;
  return moviesAndShows(
    `${base}/movies`,
    `${base}/shows`,
    (row) => row.collected_at ?? row.last_collected_at,
    connection,
    options,
  );
}

/** Rated movies and shows, by rating date, oldest first. */
function ratingsEntries(
  user: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
): Promise<SourceSnapshot> {
  // Rated seasons and episodes are left out: they do not mean the show.
  return moviesAndShows(
    `${userPath(user)}/ratings/movies`,
    `${userPath(user)}/ratings/shows`,
    (row) => row.rated_at,
    connection,
    options,
  );
}

export async function readSource(
  source: TraktSource,
  ctx: { connection: ConnectionAccess | null },
): Promise<SourceSnapshot> {
  const connection = requireConnection(source, ctx.connection);
  const options = { publicFallback: !isPersonal(source) };
  try {
    let snapshot: SourceSnapshot;
    switch (source.kind) {
      case "watchlist":
        snapshot = await listedEntries(
          `${userPath(source.user)}/watchlist?sort_by=added&sort_how=asc`,
          connection,
          options,
        );
        break;
      case "favorites":
        snapshot = await listedEntries(
          `${userPath(source.user)}/favorites?sort_by=added&sort_how=asc`,
          connection,
          options,
        );
        break;
      case "ratings":
        snapshot = await ratingsEntries(source.user, connection, options);
        break;
      case "list":
      case "shared_list":
        snapshot = await listedEntries(
          `${listPath(source)}/items?sort_by=added&sort_how=asc`,
          connection,
          options,
        );
        break;
      case "smart_list":
        snapshot = await smartListEntries(source, connection, options);
        break;
      case "chart":
      case "recommendations":
        // The first CHART_ITEMS titles are the whole Source list.
        snapshot = {
          entries: await rankedEntries(source, connection, options),
          complete: true,
        };
        break;
      case "up_next":
        snapshot = await upNextEntries(connection);
        break;
      case "history":
        snapshot = await historyEntries(source.user, connection, options);
        break;
      case "collection":
        snapshot = await collectionEntries(source.user, connection, options);
        break;
    }
    return { ...snapshot, entries: uniqueEntries(snapshot.entries) };
  } catch (error) {
    throw toSourceError(error);
  }
}

const traktListSummarySchema = z.object({
  name: z.string().nullish(),
  ids: z.object({ trakt: z.number().nullish() }).nullish(),
});

const traktSmartListSummarySchema = z.object({
  name: z.string().nullish(),
  media_type: z.string().nullish(),
  ids: z.object({ slug: z.string().nullish() }).nullish(),
});

/** A smart list of only movies or only shows starts with that one Catalog. */
export function smartListDisplayMode(
  mediaType: string | null | undefined,
): DisplayMode {
  if (mediaType === "movies") return "movie";
  if (mediaType === "shows") return "series";
  return "split";
}

const traktUserSchema = z.object({
  username: z.string().nullish(),
  ids: z.object({ slug: z.string().nullish() }).nullish(),
});

const PERSONAL_TITLES = {
  watchlist: "Trakt Watchlist",
  favorites: "Trakt Favorites",
  ratings: "Trakt Ratings",
  recommendations: "Trakt Recommendations",
  up_next: "Trakt Up Next",
  history: "Trakt History",
  collection: "Trakt Collection",
} satisfies Partial<Record<TraktSource["kind"], string>>;

/** A paginated read of each user Source list, for a one-item probe. */
const USER_PROBES: Record<UserSourceKind, string> = {
  watchlist: "watchlist",
  favorites: "favorites",
  ratings: "ratings",
  history: "history",
  collection: "collection/movies",
};

/**
 * Check that a Source list exists and can be read, and normalize its ref.
 * Costs one or two small GETs.
 */
export async function validateTraktSource(
  ref: string,
  ctx: { connection: ConnectionAccess | null },
): Promise<SourceValidation> {
  const source = parseTraktRef(ref);
  if (!source) return { ok: false, reason: "not_found" };
  const displayMode =
    source.kind === "up_next"
      ? "series"
      : source.kind === "chart" && source.chart === "boxoffice"
        ? "movie"
        : "split";

  try {
    const connection = requireConnection(source, ctx.connection);
    const options = { publicFallback: !isPersonal(source) };
    switch (source.kind) {
      case "chart":
        return {
          ok: true,
          ref: sourceToRef(source),
          suggestedTitle: CHARTS[source.chart],
          defaultDisplayMode: displayMode,
        };
      case "watchlist":
      case "favorites":
      case "ratings":
      case "history":
      case "collection": {
        if (source.user === "me") break;
        // A missing user's Source list answers 200 with no items: check
        // the profile first.
        const user = await traktGetParsed(
          userPath(source.user),
          traktUserSchema,
          connection,
          options,
        );
        if (!user) return { ok: false, reason: "not_found" };
        // One small read proves that this Source list is public too.
        await traktGetJson(
          `${userPath(source.user)}/${USER_PROBES[source.kind]}?limit=1`,
          connection,
          options,
        );
        const slug = nonEmpty(user.ids?.slug)?.toLowerCase() ?? source.user;
        return {
          ok: true,
          ref: sourceToRef({ kind: source.kind, user: slug }),
          suggestedTitle: `${nonEmpty(user.username) ?? slug}'s ${source.kind}`,
          defaultDisplayMode: displayMode,
        };
      }
      case "list":
      case "shared_list": {
        // A missing list answers 204 with no body.
        const list = await traktGetParsed(
          listPath(source),
          traktListSummarySchema,
          connection,
          options,
        );
        if (!list) return { ok: false, reason: "not_found" };
        const normalized: TraktSource =
          source.kind === "shared_list" && typeof list.ids?.trakt === "number"
            ? { kind: "shared_list", id: String(list.ids.trakt) }
            : source;
        return {
          ok: true,
          ref: sourceToRef(normalized),
          suggestedTitle: nonEmpty(list.name) ?? undefined,
          defaultDisplayMode: displayMode,
        };
      }
      case "smart_list": {
        // A private smart list is a 404 for anyone but its owner.
        const list = await traktGetParsed(
          smartListPath(source),
          traktSmartListSummarySchema,
          connection,
          options,
        );
        if (!list) return { ok: false, reason: "not_found" };
        const slug = nonEmpty(list.ids?.slug)?.toLowerCase() ?? source.slug;
        return {
          ok: true,
          ref: sourceToRef({ ...source, slug }),
          suggestedTitle: nonEmpty(list.name) ?? undefined,
          defaultDisplayMode: smartListDisplayMode(list.media_type),
        };
      }
      case "recommendations":
      case "up_next":
        break;
    }
    // Personal Source lists: one small read proves the Connection works.
    await traktGetJson("/users/settings", connection);
    return {
      ok: true,
      ref: sourceToRef(source),
      suggestedTitle: PERSONAL_TITLES[source.kind],
      defaultDisplayMode: displayMode,
    };
  } catch (error) {
    throw toSourceError(error);
  }
}
