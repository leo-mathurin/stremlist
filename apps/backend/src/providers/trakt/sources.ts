import type { DisplayMode } from "@stremlist/shared/constants";
import { z } from "zod";
import { HttpError } from "../http";
import type {
  ConnectionAccess,
  PagedRead,
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

const MAX_SOURCE_ITEMS = 5000;
const CHART_ITEMS = 100;
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
const WEEKLY_CHARTS = new Set<TraktChart>([
  "watched",
  "played",
  "collected",
  "favorited",
  "recommended",
]);

const TRAKT_CALENDARS = [
  "shows/new",
  "shows/premieres",
  "movies",
  "dvd",
] as const;
type TraktCalendar = (typeof TRAKT_CALENDARS)[number];
const CALENDAR_DAYS = 30;

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
  | { kind: "smart_list"; user: "me" | null; slug: string }
  | { kind: "chart"; chart: TraktChart }
  | { kind: "recommendations" }
  | { kind: "up_next" }
  | { kind: "continue_watching" }
  | { kind: "my_calendar" }
  | { kind: "calendar"; calendar: TraktCalendar }
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

const CALENDARS: Record<TraktCalendar, string> = {
  "shows/new": "Trakt New Shows",
  "shows/premieres": "Trakt Season Premieres",
  movies: "Trakt Upcoming Movies",
  dvd: "Trakt DVD Releases",
};

const USER_SOURCES = [
  "watchlist",
  "favorites",
  "ratings",
  "history",
  "collection",
] as const;
type UserSourceKind = (typeof USER_SOURCES)[number];

function userSourceKind(segment: string | undefined) {
  return USER_SOURCES.find((kind) => kind === segment) ?? null;
}

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseTraktRef(ref: string) {
  const parts = ref.split("/");
  const chart = TRAKT_CHARTS.find((name) => name === ref);
  if (chart) return { kind: "chart", chart } satisfies TraktSource;
  if (parts[0] === "me") {
    if (parts.length === 2) {
      const kind = userSourceKind(parts[1]);
      if (kind) return { kind, user: "me" } satisfies TraktSource;
      switch (parts[1]) {
        case "recommendations":
          return { kind: "recommendations" } satisfies TraktSource;
        case "up-next":
          return { kind: "up_next" } satisfies TraktSource;
        case "continue-watching":
          return { kind: "continue_watching" } satisfies TraktSource;
        case "calendar":
          return { kind: "my_calendar" } satisfies TraktSource;
      }
    }
    if (parts.length === 3 && parts[1] === "lists" && SEGMENT.test(parts[2])) {
      return { kind: "list", user: "me", list: parts[2] } satisfies TraktSource;
    }
    if (
      parts.length === 3 &&
      parts[1] === "smart-lists" &&
      SEGMENT.test(parts[2])
    ) {
      return {
        kind: "smart_list",
        user: "me",
        slug: parts[2].toLowerCase(),
      } satisfies TraktSource;
    }
    return null;
  }
  if (parts[0] === "users" && parts[1] && SEGMENT.test(parts[1])) {
    const user = parts[1].toLowerCase();
    const kind = userSourceKind(parts[2]);
    if (parts.length === 3 && kind) return { kind, user } satisfies TraktSource;
    if (parts.length === 4 && parts[2] === "lists" && SEGMENT.test(parts[3])) {
      return {
        kind: "list",
        user,
        list: parts[3].toLowerCase(),
      } satisfies TraktSource;
    }
    return null;
  }
  if (parts[0] === "calendars") {
    const name = parts.slice(1).join("/");
    const calendar = TRAKT_CALENDARS.find((known) => known === name);
    return calendar
      ? ({ kind: "calendar", calendar } satisfies TraktSource)
      : null;
  }
  if (parts.length === 2 && parts[0] === "lists" && SEGMENT.test(parts[1])) {
    return {
      kind: "shared_list",
      id: parts[1].toLowerCase(),
    } satisfies TraktSource;
  }
  if (
    parts.length === 2 &&
    parts[0] === "smart-lists" &&
    SEGMENT.test(parts[1])
  ) {
    return {
      kind: "smart_list",
      user: null,
      slug: parts[1].toLowerCase(),
    } satisfies TraktSource;
  }
  return null;
}

function sourceToRef(source: TraktSource) {
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
    case "continue_watching":
      return "me/continue-watching";
    case "my_calendar":
      return "me/calendar";
    case "calendar":
      return `calendars/${source.calendar}`;
  }
}

export function isPersonal(source: TraktSource) {
  if ("user" in source) return source.user === "me";
  return (
    source.kind === "recommendations" ||
    source.kind === "up_next" ||
    source.kind === "continue_watching" ||
    source.kind === "my_calendar"
  );
}

function userPath(user: string) {
  return `/users/${encodeURIComponent(user)}`;
}

function listPath(source: TraktSource & { kind: "list" | "shared_list" }) {
  return source.kind === "list"
    ? `${userPath(source.user)}/lists/${encodeURIComponent(source.list)}`
    : `/lists/${encodeURIComponent(source.id)}`;
}

function smartListPath(source: TraktSource & { kind: "smart_list" }) {
  return `/smart-lists/${encodeURIComponent(source.slug)}`;
}

function requireConnection(
  source: TraktSource,
  connection: ConnectionAccess | null,
) {
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
) {
  const { items, complete } = await traktGetAll(
    path,
    traktItemSchema,
    connection,
    { ...options, maxItems: MAX_SOURCE_ITEMS },
  );
  return newestRows(items, (item) => item.listed_at, complete);
}

function newestRows(
  rows: TraktItem[],
  date: (row: TraktItem) => string | null | undefined,
  complete = true,
) {
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
) {
  if (source.kind === "recommendations") return `/recommendations/${kind}`;
  return WEEKLY_CHARTS.has(source.chart)
    ? `/${kind}/${source.chart}/weekly`
    : `/${kind}/${source.chart}`;
}

async function rankedEntries(
  source: TraktSource & { kind: "chart" | "recommendations" },
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
  const read = (kind: "movies" | "shows") =>
    traktGetParsed(
      `${rankedPath(source, kind)}?limit=${CHART_ITEMS}`,
      z.array(rankedRowSchema),
      connection,
      options,
    );
  const [movies, shows] = await Promise.all([
    read("movies"),
    source.kind === "chart" && source.chart === "boxoffice"
      ? null
      : read("shows"),
  ]);
  const toEntry = (row: RankedRow, type: "movie" | "series") =>
    mediaToEntry((type === "movie" ? row.movie : row.show) ?? row, type);
  return interleave(
    (movies ?? []).map((row) => toEntry(row, "movie")),
    (shows ?? []).map((row) => toEntry(row, "series")),
  );
}

async function smartListEntries(
  source: TraktSource & { kind: "smart_list" },
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
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

async function upNextEntries(connection: ConnectionAccess | null) {
  let read: PagedRead<TraktItem>;
  try {
    read = await traktGetAll(
      "/sync/progress/up_next",
      traktItemSchema,
      connection,
      { maxItems: MAX_SOURCE_ITEMS },
    );
  } catch (error) {
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

async function continueWatchingEntries(connection: ConnectionAccess | null) {
  const { entries, complete } = await moviesAndShows(
    "/sync/playback/movies",
    "/sync/playback/episodes",
    (row) => row.paused_at,
    connection,
    {},
  );
  return {
    entries: uniqueEntries(entries.toReversed()).toReversed(),
    complete,
  };
}

function calendarPaths(
  source: TraktSource & { kind: "calendar" | "my_calendar" },
) {
  const window = `${new Date().toISOString().slice(0, 10)}/${CALENDAR_DAYS}`;
  return source.kind === "calendar"
    ? [`/calendars/all/${source.calendar}/${window}`]
    : [`/calendars/my/shows/${window}`, `/calendars/my/movies/${window}`];
}

async function calendarEntries(
  source: TraktSource & { kind: "calendar" | "my_calendar" },
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
  const reads = await Promise.all(
    calendarPaths(source).map((path) =>
      traktGetParsed(path, z.array(traktItemSchema), connection, options),
    ),
  );
  const rows = oldestFirst(
    reads.flatMap((read) => read ?? []),
    (row) => row.first_aired ?? row.released,
  );
  return {
    entries: rows.flatMap((row) => {
      const entry = itemToEntry(row);
      return entry ? [entry] : [];
    }),
    complete: true,
  };
}

async function moviesAndShows(
  moviesPath: string,
  showsPath: string,
  date: (row: TraktItem) => string | null | undefined,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
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

function historyEntries(
  user: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
  return moviesAndShows(
    `${userPath(user)}/watched/movies`,
    `${userPath(user)}/watched/shows?extended=noseasons`,
    (row) => row.last_watched_at,
    connection,
    options,
  );
}

function collectionEntries(
  user: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
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

function ratingsEntries(
  user: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions,
) {
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
) {
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
        snapshot = {
          entries: await rankedEntries(source, connection, options),
          complete: true,
        };
        break;
      case "up_next":
        snapshot = await upNextEntries(connection);
        break;
      case "continue_watching":
        snapshot = await continueWatchingEntries(connection);
        break;
      case "calendar":
      case "my_calendar":
        snapshot = await calendarEntries(source, connection, options);
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
export function smartListDisplayMode(mediaType: string | null | undefined) {
  const mode: DisplayMode =
    mediaType === "movies"
      ? "movie"
      : mediaType === "shows"
        ? "series"
        : "split";
  return mode;
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
  continue_watching: "Trakt Continue Watching",
  my_calendar: "Trakt Calendar",
  history: "Trakt History",
  collection: "Trakt Collection",
} satisfies Partial<Record<TraktSource["kind"], string>>;

const USER_PROBES: Record<UserSourceKind, string> = {
  watchlist: "watchlist",
  favorites: "favorites",
  ratings: "ratings",
  history: "history",
  collection: "collection/movies",
};

function defaultDisplayMode(source: TraktSource) {
  if (source.kind === "up_next") return "series";
  if (source.kind === "chart" && source.chart === "boxoffice") return "movie";
  if (source.kind === "calendar") {
    return source.calendar.startsWith("shows/") ? "series" : "movie";
  }
  return "split";
}

/**
 * Check that a Source list exists and can be read, and normalize its ref.
 * Costs one or two small GETs.
 */
export async function validateTraktSource(
  ref: string,
  ctx: { connection: ConnectionAccess | null },
) {
  const source = parseTraktRef(ref);
  if (!source)
    return { ok: false, reason: "not_found" } satisfies SourceValidation;
  const displayMode = defaultDisplayMode(source);

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
        } satisfies SourceValidation;
      case "calendar":
        return {
          ok: true,
          ref: sourceToRef(source),
          suggestedTitle: CALENDARS[source.calendar],
          defaultDisplayMode: displayMode,
        } satisfies SourceValidation;
      case "watchlist":
      case "favorites":
      case "ratings":
      case "history":
      case "collection": {
        if (source.user === "me") break;
        const user = await traktGetParsed(
          userPath(source.user),
          traktUserSchema,
          connection,
          options,
        );
        if (!user)
          return { ok: false, reason: "not_found" } satisfies SourceValidation;
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
        } satisfies SourceValidation;
      }
      case "list":
      case "shared_list": {
        const list = await traktGetParsed(
          listPath(source),
          traktListSummarySchema,
          connection,
          options,
        );
        if (!list)
          return { ok: false, reason: "not_found" } satisfies SourceValidation;
        const normalized: TraktSource =
          source.kind === "shared_list" && typeof list.ids?.trakt === "number"
            ? { kind: "shared_list", id: String(list.ids.trakt) }
            : source;
        return {
          ok: true,
          ref: sourceToRef(normalized),
          suggestedTitle: nonEmpty(list.name) ?? undefined,
          defaultDisplayMode: displayMode,
        } satisfies SourceValidation;
      }
      case "smart_list": {
        const list = await traktGetParsed(
          smartListPath(source),
          traktSmartListSummarySchema,
          connection,
          options,
        );
        if (!list)
          return { ok: false, reason: "not_found" } satisfies SourceValidation;
        const slug = nonEmpty(list.ids?.slug)?.toLowerCase() ?? source.slug;
        return {
          ok: true,
          ref: sourceToRef({ ...source, slug }),
          suggestedTitle: nonEmpty(list.name) ?? undefined,
          defaultDisplayMode: smartListDisplayMode(list.media_type),
        } satisfies SourceValidation;
      }
      case "recommendations":
      case "up_next":
      case "continue_watching":
      case "my_calendar":
        break;
    }
    await traktGetJson("/users/settings", connection);
    return {
      ok: true,
      ref: sourceToRef(source),
      suggestedTitle: PERSONAL_TITLES[source.kind],
      defaultDisplayMode: displayMode,
    } satisfies SourceValidation;
  } catch (error) {
    throw toSourceError(error);
  }
}
