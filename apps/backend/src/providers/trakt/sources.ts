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
import { nonEmpty, toSourceError, traktGetAll, traktGetJson } from "./api";
import type { TraktItem, TraktMedia } from "./entries";
import {
  interleave,
  itemToEntry,
  mediaToEntry,
  oldestFirst,
  uniqueEntries,
  withAddedAt,
} from "./entries";

/** Most entries read from one Source list. */
const MAX_SOURCE_ITEMS = 5000;
/** Charts and recommendations: one page per kind is plenty. */
const CHART_ITEMS = 100;

type TraktChart = "trending" | "popular" | "anticipated";

/**
 * A Trakt Source list reference, parsed. `user: "me"` reads through the
 * Connection.
 */
export type TraktSource =
  | { kind: "watchlist"; user: string }
  | { kind: "list"; user: string; list: string }
  | { kind: "shared_list"; id: string }
  | { kind: "chart"; chart: TraktChart }
  | { kind: "recommendations" }
  | { kind: "up_next" }
  | { kind: "history" }
  | { kind: "collection" };

const CHARTS: Record<TraktChart, string> = {
  trending: "Trakt Trending",
  popular: "Trakt Popular",
  anticipated: "Trakt Anticipated",
};

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseTraktRef(ref: string): TraktSource | null {
  const parts = ref.split("/");
  if (parts.length === 1 && ref in CHARTS) {
    return { kind: "chart", chart: ref as TraktChart };
  }
  if (parts[0] === "me") {
    if (parts.length === 2) {
      switch (parts[1]) {
        case "watchlist":
          return { kind: "watchlist", user: "me" };
        case "recommendations":
          return { kind: "recommendations" };
        case "up-next":
          return { kind: "up_next" };
        case "history":
          return { kind: "history" };
        case "collection":
          return { kind: "collection" };
      }
    }
    if (parts.length === 3 && parts[1] === "lists" && SEGMENT.test(parts[2])) {
      return { kind: "list", user: "me", list: parts[2] };
    }
    return null;
  }
  if (parts[0] === "users" && parts[1] && SEGMENT.test(parts[1])) {
    const user = parts[1].toLowerCase();
    if (parts.length === 3 && parts[2] === "watchlist") {
      return { kind: "watchlist", user };
    }
    if (parts.length === 4 && parts[2] === "lists" && SEGMENT.test(parts[3])) {
      return { kind: "list", user, list: parts[3].toLowerCase() };
    }
    return null;
  }
  if (parts.length === 2 && parts[0] === "lists" && SEGMENT.test(parts[1])) {
    return { kind: "shared_list", id: parts[1].toLowerCase() };
  }
  return null;
}

function sourceToRef(source: TraktSource): string {
  switch (source.kind) {
    case "watchlist":
      return source.user === "me"
        ? "me/watchlist"
        : `users/${source.user}/watchlist`;
    case "list":
      return source.user === "me"
        ? `me/lists/${source.list}`
        : `users/${source.user}/lists/${source.list}`;
    case "shared_list":
      return `lists/${source.id}`;
    case "chart":
      return source.chart;
    case "recommendations":
      return "me/recommendations";
    case "up_next":
      return "me/up-next";
    case "history":
      return "me/history";
    case "collection":
      return "me/collection";
  }
}

export function isPersonal(source: TraktSource): boolean {
  if (source.kind === "watchlist" || source.kind === "list") {
    return source.user === "me";
  }
  return (
    source.kind === "recommendations" ||
    source.kind === "up_next" ||
    source.kind === "history" ||
    source.kind === "collection"
  );
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

function requireConnection(
  source: TraktSource,
  connection: ConnectionAccess | null,
): ConnectionAccess | null {
  if (isPersonal(source)) return personalConnection(source, connection);
  return connection;
}

function personalConnection(
  source: TraktSource,
  connection: ConnectionAccess | null,
): ConnectionAccess {
  if (!connection) {
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
  const { items, complete } = await traktGetAll<TraktItem>(path, connection, {
    ...options,
    maxItems: MAX_SOURCE_ITEMS,
  });
  return {
    entries: oldestFirst(items, (item) => item.listed_at).flatMap((item) => {
      const entry = itemToEntry(item);
      return entry ? [withAddedAt(entry, item.listed_at)] : [];
    }),
    complete,
  };
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

async function chartEntries(
  chart: TraktChart,
  connection: ConnectionAccess | null,
): Promise<SourceEntry[]> {
  const read = (kind: "movies" | "shows") =>
    traktGetJson<(TraktItem & TraktMedia)[]>(
      `/${kind}/${chart}?limit=${CHART_ITEMS}`,
      connection,
      { publicFallback: true },
    );
  const [movies, shows] = await Promise.all([read("movies"), read("shows")]);
  // Popular rows are the media itself; trending and anticipated wrap it.
  const toEntry = (row: TraktItem & TraktMedia, type: "movie" | "series") => {
    const media = (type === "movie" ? row.movie : row.show) ?? row;
    return mediaToEntry(media, type);
  };
  return interleave(
    (movies ?? []).map((row) => toEntry(row, "movie")),
    (shows ?? []).map((row) => toEntry(row, "series")),
  );
}

async function recommendationEntries(
  connection: ConnectionAccess,
): Promise<SourceEntry[]> {
  const read = (kind: "movies" | "shows") =>
    traktGetJson<TraktMedia[]>(
      `/recommendations/${kind}?limit=${CHART_ITEMS}`,
      connection,
    );
  const [movies, shows] = await Promise.all([read("movies"), read("shows")]);
  return interleave(
    (movies ?? []).map((media) => mediaToEntry(media, "movie")),
    (shows ?? []).map((media) => mediaToEntry(media, "series")),
  );
}

/** Shows in progress, oldest watched first (the show, not the next episode). */
async function upNextEntries(
  connection: ConnectionAccess,
): Promise<SourceSnapshot> {
  let read: PagedRead<TraktItem>;
  try {
    read = await traktGetAll<TraktItem>("/sync/progress/up_next", connection, {
      maxItems: MAX_SOURCE_ITEMS,
    });
  } catch (error) {
    // Up next is a limited-access endpoint for some apps. Watched progress
    // without completed shows gives the same rows.
    if (
      !(error instanceof HttpError) ||
      ![403, 404, 405].includes(error.status)
    ) {
      throw error;
    }
    read = await traktGetAll<TraktItem>(
      "/sync/progress/watched?hide_completed=true",
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

/** Watched movies and shows, by last watch, oldest first. */
async function historyEntries(
  connection: ConnectionAccess,
): Promise<SourceSnapshot> {
  const [movies, shows] = await Promise.all([
    traktGetJson<TraktItem[]>("/users/me/watched/movies", connection),
    traktGetJson<TraktItem[]>(
      "/users/me/watched/shows?extended=noseasons",
      connection,
    ),
  ]);
  return newestRows(
    [...(movies ?? []), ...(shows ?? [])],
    (row) => row.last_watched_at,
  );
}

async function collectionEntries(
  connection: ConnectionAccess,
): Promise<SourceSnapshot> {
  const [movies, shows] = await Promise.all([
    traktGetAll<TraktItem>("/sync/collection/movies", connection, {
      maxItems: MAX_SOURCE_ITEMS,
    }),
    traktGetJson<TraktItem[]>("/sync/collection/shows", connection),
  ]);
  return newestRows(
    [...movies.items, ...(shows ?? [])],
    (row) => row.collected_at ?? row.last_collected_at,
    movies.complete,
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
      case "list":
      case "shared_list":
        snapshot = await listedEntries(
          `${listPath(source)}/items?sort_by=added&sort_how=asc`,
          connection,
          options,
        );
        break;
      case "chart":
      case "recommendations":
        // The first CHART_ITEMS titles are the whole Source list.
        snapshot = {
          entries: await (source.kind === "chart"
            ? chartEntries(source.chart, connection)
            : recommendationEntries(personalConnection(source, connection))),
          complete: true,
        };
        break;
      case "up_next":
        snapshot = await upNextEntries(personalConnection(source, connection));
        break;
      case "history":
        snapshot = await historyEntries(personalConnection(source, connection));
        break;
      case "collection":
        snapshot = await collectionEntries(
          personalConnection(source, connection),
        );
        break;
    }
    return { ...snapshot, entries: uniqueEntries(snapshot.entries) };
  } catch (error) {
    throw toSourceError(error);
  }
}

interface TraktListSummary {
  name?: string | null;
  ids?: { trakt?: number | null; slug?: string | null } | null;
  user?: {
    username?: string | null;
    ids?: { slug?: string | null } | null;
  } | null;
}

interface TraktUser {
  username?: string | null;
  name?: string | null;
  ids?: { slug?: string | null } | null;
}

const PERSONAL_TITLES: Record<string, string> = {
  watchlist: "Trakt Watchlist",
  recommendations: "Trakt Recommendations",
  up_next: "Trakt Up Next",
  history: "Trakt History",
  collection: "Trakt Collection",
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
  const displayMode = source.kind === "up_next" ? "series" : "split";

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
      case "watchlist": {
        if (source.user === "me") break;
        // A missing user's watchlist answers 200 with no items: check the
        // profile first.
        const user = await traktGetJson<TraktUser>(
          userPath(source.user),
          connection,
          options,
        );
        if (!user) return { ok: false, reason: "not_found" };
        await traktGetJson(
          `${userPath(source.user)}/watchlist?limit=1`,
          connection,
          options,
        );
        const slug = nonEmpty(user.ids?.slug)?.toLowerCase() ?? source.user;
        return {
          ok: true,
          ref: sourceToRef({ kind: "watchlist", user: slug }),
          suggestedTitle: `${nonEmpty(user.username) ?? slug}'s watchlist`,
          defaultDisplayMode: displayMode,
        };
      }
      case "list":
      case "shared_list": {
        // A missing list answers 204 with no body.
        const list = await traktGetJson<TraktListSummary>(
          listPath(source),
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
