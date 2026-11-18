import type { DisplayMode, TitleType } from "./constants";
import {
  IMDB_LIST_ID_PATTERN,
  IMDB_LS_ID_SOURCE,
  IMDB_P_HANDLE_SOURCE,
  IMDB_RATINGS_REF_PATTERN,
  IMDB_UR_ID_SOURCE,
  IMDB_USER_ID_PATTERN,
} from "./constants";
import { CHART_REGISTRY, imdbChartOf, isChartId } from "./imdb-charts";
import {
  SIMKL_CHART_PERIODS,
  SIMKL_CHART_TYPE_INFO,
  SIMKL_CHART_TYPES,
  SIMKL_GENRE_REF_PATTERN,
  SIMKL_PERIOD_SUFFIX,
  simklGenreChartOf,
  simklTrendingRef,
} from "./simkl-charts";

/**
 * Providers: the external services that keep lists of Titles. See CONTEXT.md.
 * This module is pure (no network) so the configure page can detect a pasted
 * link instantly and the backend can validate the same way.
 */
export const PROVIDER_IDS = [
  "imdb",
  "trakt",
  "simkl",
  "mdblist",
  "justwatch",
  "senscritique",
  "letterboxd",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ActionKind = "watchlist" | "watched" | "rating";

interface ProviderInfo {
  label: string;
  /** "soon": shown in the UI, but no Source list can be added yet. */
  availability: "available" | "soon";
  /**
   * "none": public links only. "optional": public links or charts work, a
   * Connection unlocks private Source lists and Actions. "required": every
   * Source list needs a Connection.
   */
  connection: "none" | "optional" | "required";
  /** Actions this Provider supports when the Account has a Connection. */
  actions: readonly ActionKind[];
  /** Example of a link the user can paste, shown as a hint. */
  linkExample: string | null;
  /** A limit to know before connecting, shown next to Connect. */
  connectNote?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  imdb: {
    label: "IMDb",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://www.imdb.com/user/ur12345678/watchlist",
  },
  trakt: {
    label: "Trakt",
    availability: "available",
    connection: "optional",
    actions: ["watchlist", "watched", "rating"],
    linkExample: "https://trakt.tv/users/username/watchlist",
    // Since 2026-07-22 (docs/architecture.md).
    connectNote:
      "A free Trakt account can connect only one app. If Stremio's own Trakt sync uses it, paste public Trakt links instead.",
  },
  simkl: {
    label: "Simkl",
    availability: "available",
    // Its trending charts need no Connection (PUBLIC_SOURCES).
    connection: "optional",
    actions: ["watchlist", "watched", "rating"],
    linkExample: null,
  },
  mdblist: {
    label: "MDBList",
    availability: "available",
    connection: "required",
    actions: ["watchlist", "watched", "rating"],
    linkExample: "https://mdblist.com/lists/username/list-name",
  },
  justwatch: {
    label: "JustWatch",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://www.justwatch.com/shared?id=tl-us-…",
  },
  senscritique: {
    label: "SensCritique",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://www.senscritique.com/username/collection?action=WISH",
  },
  letterboxd: {
    label: "Letterboxd",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://letterboxd.com/username/watchlist/",
  },
};

/** "Trakt", "Trakt and Simkl", "Trakt, Simkl and MDBList" (or "or"). */
export function joinProviderLabels(
  providers: readonly ProviderId[],
  word: "and" | "or" = "and",
): string {
  const labels = providers.map((provider) => PROVIDERS[provider].label);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} ${word} ${labels.at(-1) ?? ""}`;
}

/** Providers whose links the user can paste today. */
export const LINK_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS.filter(
  (id) =>
    PROVIDERS[id].availability === "available" && !!PROVIDERS[id].linkExample,
);

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * What a Source list is on its Provider. Used for default titles, icons and
 * which display modes make sense; the adapter owns the real semantics.
 */
export type SourceKind =
  | "watchlist"
  | "list"
  | "chart"
  | "recommendations"
  | "up_next"
  | "history"
  | "collection"
  | "status";

/** How the configure page and default titles name each kind. */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  watchlist: "Watchlist",
  list: "List",
  chart: "Chart",
  recommendations: "Recommendations",
  up_next: "Up Next",
  history: "History",
  collection: "Collection",
  status: "Status",
};

/**
 * The identity of a Source list, as Lists, statuses and previews name it:
 * its Provider and the reference that the Provider understands.
 */
export interface SourceId {
  provider: ProviderId;
  sourceRef: string;
}

export interface ParsedSourceLink extends SourceId {
  kind: SourceKind;
  /** Default catalog title suggestion, when the link carries one. */
  suggestedTitle?: string;
}

/** A Source list that becomes available once a Provider is connected. */
export interface ConnectionSource {
  ref: string;
  kind: SourceKind;
  label: string;
  defaultDisplayMode: DisplayMode;
  /** The only Title type that this Source list contains, if it has one. */
  titleType?: TitleType;
  /** The Source list page on its Provider, for a public one. */
  url?: string;
  /**
   * Quick add offers it in the Provider's chart menu, not as a button of
   * its own.
   */
  menu?: boolean;
}

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return new URL(
      /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return null;
  }
}

function hostIs(url: URL, ...domains: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * The decoded path segments, or none when the path is not valid percent
 * encoding (`alice%`), so the link reads as unrecognized instead of throwing
 * while the page renders.
 */
function segments(url: URL): string[] {
  try {
    return url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return [];
  }
}

const IMDB_UR = new RegExp(
  String.raw`(?:^|[^a-z0-9])(${IMDB_UR_ID_SOURCE})(?![0-9])`,
  "i",
);
const IMDB_LS = new RegExp(
  String.raw`(?:^|[^a-z0-9])(${IMDB_LS_ID_SOURCE})(?![0-9])`,
  "i",
);
const IMDB_P_HANDLE = new RegExp(
  String.raw`(?:^|\/)(${IMDB_P_HANDLE_SOURCE})(?:$|[/?#])`,
);

function parseImdbLink(input: string): ParsedSourceLink | null {
  const trimmed = input.trim();
  if (isChartId(trimmed)) {
    return { provider: "imdb", sourceRef: trimmed, kind: "chart" };
  }
  const url = toUrl(trimmed);
  const isImdbUrl = url !== null && hostIs(url, "imdb.com");
  // Bare IDs (ur…, ls…, p.handle) keep working, as they did before links.
  const bare =
    !/[/.:]/.test(trimmed.replace(/^p\./, "")) ||
    /^p\.[a-zA-Z0-9]+$/.test(trimmed);
  if (!isImdbUrl && !bare) return null;

  // imdb.com/user/{ur… or p.handle}/ratings: the ratings, not the watchlist
  // of the user ID that the link also contains.
  const parts = url && isImdbUrl ? segments(url) : [];
  if (
    parts[0]?.toLowerCase() === "user" &&
    parts[2]?.toLowerCase() === "ratings"
  ) {
    const user = parts[1].startsWith("p.") ? parts[1] : parts[1].toLowerCase();
    const sourceRef = `${user}/ratings`;
    return parts.length === 3 && IMDB_RATINGS_REF_PATTERN.test(sourceRef)
      ? { provider: "imdb", sourceRef, kind: "list" }
      : null;
  }

  const list = IMDB_LS.exec(trimmed);
  if (list) {
    return { provider: "imdb", sourceRef: list[1].toLowerCase(), kind: "list" };
  }
  const user = IMDB_UR.exec(trimmed);
  if (user) {
    return {
      provider: "imdb",
      sourceRef: user[1].toLowerCase(),
      kind: "watchlist",
    };
  }
  const handle = IMDB_P_HANDLE.exec(trimmed);
  if (handle) {
    return { provider: "imdb", sourceRef: handle[1], kind: "watchlist" };
  }
  return null;
}

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
/** Trakt charts counted over a period: Stremlist reads the weekly one. */
const TRAKT_WEEKLY_CHARTS = new Set<string>([
  "watched",
  "played",
  "collected",
  "favorited",
  "recommended",
]);
/** Source lists of a Trakt user, at trakt.tv/users/{user}/{kind}. */
const TRAKT_USER_SOURCES = new Map<string, SourceKind>([
  ["favorites", "list"],
  ["ratings", "list"],
  ["history", "history"],
  ["collection", "collection"],
]);
// trakt.tv/lists/{these} are pages that browse lists, not lists.
const TRAKT_LIST_PAGES = new Set([
  "trending",
  "popular",
  "liked",
  "official",
  "personal",
  "smart",
]);

function parseTraktLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  // trakt.tv and app.trakt.tv share the same paths.
  if (!url || !hostIs(url, "trakt.tv")) return null;
  const parts = segments(url);
  // trakt.tv/users/{user}/watchlist and trakt.tv/users/{user}/lists/{list}[/items]
  if (parts[0] === "users" && parts[1]) {
    const user = parts[1].toLowerCase();
    // "me" is the signed-in user: only a Connection can read it.
    const owner = user === "me" ? "me" : `users/${user}`;
    if (parts[2] === "watchlist") {
      return {
        provider: "trakt",
        sourceRef: `${owner}/watchlist`,
        kind: "watchlist",
        suggestedTitle: user === "me" ? undefined : `${parts[1]}'s watchlist`,
      };
    }
    if (parts[2] === "lists" && parts[3]) {
      return {
        provider: "trakt",
        sourceRef: `${owner}/lists/${parts[3].toLowerCase()}`,
        kind: "list",
      };
    }
    // trakt.tv/users/{user}/favorites, /ratings, /history, /collection.
    const userKind =
      parts.length === 3 ? TRAKT_USER_SOURCES.get(parts[2]) : undefined;
    if (userKind) {
      return {
        provider: "trakt",
        sourceRef: `${owner}/${parts[2]}`,
        kind: userKind,
        suggestedTitle: user === "me" ? undefined : `${parts[1]}'s ${parts[2]}`,
      };
    }
  }
  // app.trakt.tv/lists/smart/view/{slug}: a smart list, which Trakt fills
  // from its filters.
  if (
    parts[0] === "lists" &&
    parts[1]?.toLowerCase() === "smart" &&
    parts[2]?.toLowerCase() === "view" &&
    parts[3]
  ) {
    return {
      provider: "trakt",
      sourceRef: `smart-lists/${parts[3].toLowerCase()}`,
      kind: "list",
    };
  }
  // trakt.tv/lists/official/{slug}: an official list (collections). The
  // API reads it by slug, like any shared list.
  if (
    parts[0] === "lists" &&
    parts[1]?.toLowerCase() === "official" &&
    parts[2]
  ) {
    return {
      provider: "trakt",
      sourceRef: `lists/${parts[2].toLowerCase()}`,
      kind: "list",
    };
  }
  // trakt.tv/lists/{id}: official and shared lists by numeric ID or slug.
  if (
    parts[0] === "lists" &&
    parts[1] &&
    !TRAKT_LIST_PAGES.has(parts[1].toLowerCase())
  ) {
    return {
      provider: "trakt",
      sourceRef: `lists/${parts[1].toLowerCase()}`,
      kind: "list",
    };
  }
  // trakt.tv/movies/trending, trakt.tv/shows/popular…: the chart covers
  // both kinds. A chart counted over a period is read for the week.
  if (parts[0] === "movies" || parts[0] === "shows") {
    const chart = TRAKT_CHARTS.find((name) => name === parts[1]?.toLowerCase());
    const weekly =
      parts.length === 3 &&
      parts[2].toLowerCase() === "weekly" &&
      !!chart &&
      TRAKT_WEEKLY_CHARTS.has(chart);
    if (chart && (parts.length === 2 || weekly)) {
      return { provider: "trakt", sourceRef: chart, kind: "chart" };
    }
  }
  return null;
}

function parseMdblistLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "mdblist.com")) return null;
  const parts = segments(url);
  // mdblist.com/lists/{user}/{slug}: the backend resolves it to `lists/{id}`.
  if (parts[0] === "lists" && parts[1] && parts[2] && parts.length === 3) {
    return {
      provider: "mdblist",
      sourceRef: `lists/${parts[1]}/${parts[2]}`,
      kind: "list",
    };
  }
  // mdblist.com/watchlist/{user}: MDBList only shares the connected user's
  // own watchlist, so the backend turns it into `me/watchlist`.
  if (parts[0] === "watchlist" && parts[1] && parts.length === 2) {
    return {
      provider: "mdblist",
      sourceRef: `watchlist/${parts[1]}`,
      kind: "watchlist",
      suggestedTitle: "MDBList watchlist",
    };
  }
  return null;
}

// User lists use a UUID ("tl-us-<uuid>"); JustWatch's own editorial lists
// can use a number ("tl-tu-12653").
const JUSTWATCH_LIST_ID =
  /\b(tl-[a-z]{2}-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+))\b/i;

function parseJustwatchLink(input: string): ParsedSourceLink | null {
  const trimmed = input.trim();
  const url = toUrl(trimmed);
  const isJustwatch = url !== null && hostIs(url, "justwatch.com");
  if (!isJustwatch && !/^tl-/i.test(trimmed)) return null;
  const match = JUSTWATCH_LIST_ID.exec(trimmed);
  if (!match) return null;
  return {
    provider: "justwatch",
    sourceRef: match[1].toLowerCase(),
    kind: "list",
  };
}

/**
 * The collections of a SensCritique user that Stremlist reads, by the name in
 * their stored reference (`users/{user}/{name}`). `action` is the collection
 * action, the same in the site links and in the API.
 */
export const SENSCRITIQUE_COLLECTIONS = {
  wishes: { action: "WISH", kind: "watchlist", noun: "wishlist" },
  done: { action: "DONE", kind: "history", noun: "watched" },
  rated: { action: "RATING", kind: "list", noun: "ratings" },
  recommend: { action: "RECOMMEND", kind: "list", noun: "favorites" },
} as const satisfies Record<
  string,
  { action: string; kind: SourceKind; noun: string }
>;
export type SensCritiqueCollection = keyof typeof SENSCRITIQUE_COLLECTIONS;

export function isSensCritiqueCollection(
  name: string,
): name is SensCritiqueCollection {
  return Object.hasOwn(SENSCRITIQUE_COLLECTIONS, name);
}

/** The collection behind a collection link action, such as "done" or "DONE". */
function sensCritiqueCollectionOf(
  action: string,
): SensCritiqueCollection | null {
  const upper = action.toUpperCase();
  for (const [name, { action: known }] of Object.entries(
    SENSCRITIQUE_COLLECTIONS,
  )) {
    if (known === upper && isSensCritiqueCollection(name)) return name;
  }
  return null;
}

/**
 * Collection link filters that Stremlist cannot apply: a link with one of
 * them is refused instead of read without the filter.
 */
const SENSCRITIQUE_COLLECTION_FILTERS = [
  "categoryId",
  "gameSystemId",
  "genreId",
  "keywords",
  "maxPeriod",
  "minPeriod",
  "releaseDate",
  "yearDateDone",
];

/** SensCritique universes in collection links: 1 for films, 4 for series. */
const SENSCRITIQUE_FILM_SERIES_UNIVERSES = new Set(["1", "4"]);

/** The SensCritique charts at senscritique.com/{films|series}/tops/{page}. */
const SENSCRITIQUE_CHART_PAGES = new Map([
  ["top111", "top111"],
  ["top100-des-top10", "top100"],
]);

function parseSensCritiqueLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "senscritique.com")) return null;
  const parts = segments(url);
  const first = parts[0]?.toLowerCase();
  // senscritique.com/liste/{slug}/{id}
  if (first === "liste") {
    const id = parts.slice(1).find((part) => /^\d+$/.test(part));
    return id
      ? { provider: "senscritique", sourceRef: `lists/${id}`, kind: "list" }
      : null;
  }
  // senscritique.com/top/resultats/{slug}/{id}: the results of a poll.
  if (first === "top") {
    const id =
      parts[1]?.toLowerCase() === "resultats"
        ? parts.slice(2).find((part) => /^\d+$/.test(part))
        : undefined;
    return id
      ? { provider: "senscritique", sourceRef: `polls/${id}`, kind: "chart" }
      : null;
  }
  // senscritique.com/films/tops/top111, /series/tops/top100-des-top10…
  if (
    (first === "films" || first === "series") &&
    parts[1]?.toLowerCase() === "tops" &&
    parts.length === 3
  ) {
    const chart = SENSCRITIQUE_CHART_PAGES.get(parts[2].toLowerCase());
    if (!chart) return null;
    return {
      provider: "senscritique",
      sourceRef: `${chart}-${first === "films" ? "movies" : "series"}`,
      kind: "chart",
    };
  }
  // Top-level paths of senscritique.com that are not user profiles.
  const reserved = new Set([
    "_next",
    "about",
    "activity",
    "agenda",
    "album",
    "app",
    "app-icons",
    "application",
    "apropos",
    "bd",
    "communaute",
    "contact",
    "critique",
    "decouvrir",
    "explore",
    "extension",
    "film",
    "films",
    "jeuvideo",
    "jeuxvideo",
    "l-edito",
    "liste",
    "listes",
    "livre",
    "livres",
    "login",
    "morceau",
    "musique",
    "news",
    "recherche",
    "register",
    "search",
    "searchlist",
    "serie",
    "series",
    "settings",
    "sondages",
    "top",
  ]);
  // senscritique.com/{username} (its wishes), or one of its collections:
  // /{username}/collection?action=DONE&universe=1. The universe is optional:
  // the collection reads films and series.
  const username = parts[0];
  if (!username || reserved.has(username.toLowerCase())) return null;
  if (!/^[\w.-]+$/.test(username)) return null;
  let collection: SensCritiqueCollection = "wishes";
  if (parts[1]?.toLowerCase() === "collection") {
    const { searchParams } = url;
    const action = searchParams.get("action");
    const universe = searchParams.get("universe");
    if (action) {
      const found = sensCritiqueCollectionOf(action);
      if (!found) return null;
      collection = found;
    }
    if (universe && !SENSCRITIQUE_FILM_SERIES_UNIVERSES.has(universe)) {
      return null;
    }
    if (SENSCRITIQUE_COLLECTION_FILTERS.some((key) => searchParams.get(key))) {
      return null;
    }
  }
  const { kind, noun } = SENSCRITIQUE_COLLECTIONS[collection];
  return {
    provider: "senscritique",
    sourceRef: `users/${username}/${collection}`,
    kind,
    suggestedTitle: `${username}'s ${noun}`,
  };
}

function parseLetterboxdLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;

  // boxd.it short links (public or share). The backend follows the redirect
  // in validateSource, so carry the raw code (and its $token, if any) as a
  // provisional reference. The $token is case-sensitive, so keep it verbatim.
  if (hostIs(url, "boxd.it")) {
    const code = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9]+(?:\$[A-Za-z0-9]+)?$/.test(code)) return null;
    return {
      provider: "letterboxd",
      sourceRef: `lbxshort/${code}`,
      kind: "list",
    };
  }

  if (
    !["letterboxd.com", "www.letterboxd.com"].includes(
      url.hostname.toLowerCase(),
    )
  )
    return null;
  const parts = segments(url);
  const user = parts[0]?.toLowerCase();
  if (!user || !/^[a-z0-9_]{1,40}$/.test(user)) return null;
  if (parts[1] === "watchlist" && parts.length === 2) {
    return {
      provider: "letterboxd",
      sourceRef: `users/${user}/watchlist`,
      kind: "watchlist",
      suggestedTitle: `${user}'s watchlist`,
    };
  }
  // The diary, at /{user}/diary/ or /{user}/films/diary/ (which redirects to it).
  const diary =
    (parts[1] === "diary" && parts.length === 2) ||
    (parts[1] === "films" && parts[2] === "diary" && parts.length === 3);
  if (diary) {
    return {
      provider: "letterboxd",
      sourceRef: `users/${user}/diary`,
      kind: "history",
      suggestedTitle: `${user}'s diary`,
    };
  }
  if (parts[1] === "films") {
    // Rating-filtered films: /{user}/films/rated/4.0-5.0/ is its own Source list.
    if (
      parts[2] === "rated" &&
      parts[3] &&
      /^\d(?:\.\d)?(?:-\d(?:\.\d)?)?$/.test(parts[3]) &&
      parts.length === 4
    ) {
      // Letterboxd's own form drops trailing zeros (4.0-5.0 is 4-5).
      const range = parts[3]
        .split("-")
        .map((value) => String(Number(value)))
        .join("-");
      return {
        provider: "letterboxd",
        sourceRef: `users/${user}/films/rated/${range}`,
        kind: "list",
        suggestedTitle: `${user}'s films rated ${range}`,
      };
    }
    // Watched films: /{user}/films/.
    if (parts.length === 2) {
      return {
        provider: "letterboxd",
        sourceRef: `users/${user}/films`,
        kind: "list",
        suggestedTitle: `${user}'s films`,
      };
    }
  }
  // Liked films: /{user}/likes/films/.
  if (parts[1] === "likes" && parts[2] === "films" && parts.length === 3) {
    return {
      provider: "letterboxd",
      sourceRef: `users/${user}/likes/films`,
      kind: "list",
      suggestedTitle: `${user}'s liked films`,
    };
  }
  const slug = parts[2]?.toLowerCase();
  if (
    parts[1] === "list" &&
    slug &&
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)
  ) {
    // Share link: /{user}/list/{slug}/share/{token}/. The token is the secret
    // and is case-sensitive, so keep it verbatim; the backend encrypts it
    // before storage.
    if (parts[3] === "share" && parts.length === 5) {
      const token = parts[4];
      if (!/^[A-Za-z0-9]+$/.test(token)) return null;
      return {
        provider: "letterboxd",
        sourceRef: `lbxshare/${user}/list/${slug}/share/${token}`,
        kind: "list",
      };
    }
    if (parts.length === 3) {
      return {
        provider: "letterboxd",
        sourceRef: `users/${user}/lists/${slug}`,
        kind: "list",
      };
    }
  }
  return null;
}

const LINK_PARSERS: ((input: string) => ParsedSourceLink | null)[] = [
  parseTraktLink,
  parseMdblistLink,
  parseJustwatchLink,
  parseSensCritiqueLink,
  parseLetterboxdLink,
  // IMDb last: it also accepts bare IDs.
  parseImdbLink,
];

/**
 * Detect the Provider and Source list behind a pasted link (or a bare IMDb
 * ID). Returns null when no Provider recognizes the input.
 */
export function parseSourceLink(input: string): ParsedSourceLink | null {
  for (const parse of LINK_PARSERS) {
    const parsed = parse(input);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Source lists that a Connection unlocks, per Provider. The configure page
 * offers them as one-click additions after the user connects.
 */
export const CONNECTION_SOURCES: Partial<
  Record<ProviderId, ConnectionSource[]>
> = {
  trakt: [
    {
      ref: "me/watchlist",
      kind: "watchlist",
      label: "Watchlist",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/favorites",
      kind: "list",
      label: "Favorites",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/ratings",
      kind: "list",
      label: "Ratings",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/recommendations",
      kind: "recommendations",
      label: "Recommendations",
      defaultDisplayMode: "split",
    },
    // Up Next lists the series in progress (docs/architecture.md).
    {
      ref: "me/up-next",
      kind: "up_next",
      label: "Up Next",
      defaultDisplayMode: "series",
      titleType: "series",
    },
    {
      ref: "me/history",
      kind: "history",
      label: "History",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/collection",
      kind: "collection",
      label: "Collection",
      defaultDisplayMode: "split",
    },
  ],
  simkl: [
    {
      ref: "me/plantowatch",
      kind: "watchlist",
      label: "Plan to watch",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/watching",
      kind: "status",
      label: "Watching",
      defaultDisplayMode: "series",
    },
    {
      ref: "me/completed",
      kind: "status",
      label: "Completed",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/hold",
      kind: "status",
      label: "On hold",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/dropped",
      kind: "status",
      label: "Dropped",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/history",
      kind: "history",
      label: "History",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/ratings",
      kind: "list",
      label: "Ratings",
      defaultDisplayMode: "split",
    },
    // The next episodes of the series in Watching, and the movies in Plan to
    // watch that come out, from Simkl's airing calendar.
    {
      ref: "me/airing-soon",
      kind: "up_next",
      label: "Airing Soon",
      defaultDisplayMode: "split",
    },
    // Paused playback sessions, dated by the pause.
    {
      ref: "me/continue-watching",
      kind: "up_next",
      label: "Continue Watching",
      defaultDisplayMode: "split",
    },
  ],
  // The user's own lists (`me/lists/{id}`), external lists
  // (`me/external/{id}`) and liked lists (`lists/{id}`) depend on the
  // account; the backend lists them. Every MDBList read needs the
  // Connection, so its official charts are here too.
  mdblist: [
    {
      ref: "me/watchlist",
      kind: "watchlist",
      label: "Watchlist",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/ratings",
      kind: "list",
      label: "Ratings",
      defaultDisplayMode: "split",
    },
    {
      ref: "me/history",
      kind: "history",
      label: "History",
      defaultDisplayMode: "split",
    },
    {
      ref: "official/trending",
      kind: "chart",
      label: "Trending",
      defaultDisplayMode: "split",
    },
    {
      ref: "official/popular",
      kind: "chart",
      label: "Popular",
      defaultDisplayMode: "split",
    },
    {
      ref: "official/anticipated",
      kind: "chart",
      label: "Anticipated",
      defaultDisplayMode: "split",
    },
    {
      ref: "official/most-watched",
      kind: "chart",
      label: "Most Watched (Past Year)",
      defaultDisplayMode: "split",
    },
  ],
};

/** Source lists that need no link and no Connection (charts, trending…). */
export const PUBLIC_SOURCES: Partial<Record<ProviderId, ConnectionSource[]>> = {
  trakt: [
    {
      ref: "trending",
      kind: "chart",
      label: "Trending",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/trending",
    },
    {
      ref: "popular",
      kind: "chart",
      label: "Popular",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/popular",
    },
    {
      ref: "anticipated",
      kind: "chart",
      label: "Anticipated",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/anticipated",
    },
    {
      ref: "boxoffice",
      kind: "chart",
      label: "Box Office",
      defaultDisplayMode: "movie",
      titleType: "movie",
      url: "https://trakt.tv/movies/boxoffice",
    },
    {
      ref: "watched",
      kind: "chart",
      label: "Most Watched",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/watched/weekly",
    },
    {
      ref: "played",
      kind: "chart",
      label: "Most Played",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/played/weekly",
    },
    {
      ref: "collected",
      kind: "chart",
      label: "Most Collected",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/collected/weekly",
    },
    {
      ref: "favorited",
      kind: "chart",
      label: "Most Favorited",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/favorited/weekly",
    },
    {
      ref: "recommended",
      kind: "chart",
      label: "Most Recommended",
      defaultDisplayMode: "split",
      url: "https://trakt.tv/movies/recommended/weekly",
    },
  ],
  senscritique: [
    {
      ref: "top111-movies",
      kind: "chart",
      label: "Top 111 Movies",
      defaultDisplayMode: "movie",
      titleType: "movie",
      url: "https://www.senscritique.com/films/tops/top111",
    },
    {
      ref: "top111-series",
      kind: "chart",
      label: "Top 111 TV Shows",
      defaultDisplayMode: "series",
      titleType: "series",
      url: "https://www.senscritique.com/series/tops/top111",
    },
    // Ranked from the members' top 10s.
    {
      ref: "top100-movies",
      kind: "chart",
      label: "Top 100 Favorite Movies",
      defaultDisplayMode: "movie",
      titleType: "movie",
      url: "https://www.senscritique.com/films/tops/top100-des-top10",
    },
    {
      ref: "top100-series",
      kind: "chart",
      label: "Top 100 Favorite TV Shows",
      defaultDisplayMode: "series",
      titleType: "series",
      url: "https://www.senscritique.com/series/tops/top100-des-top10",
    },
  ],
  // Simkl's trending and DVD files. Simkl's API rules ask that a trending
  // section names Simkl: the Catalogs are "Simkl Trending Movies"… The
  // week's charts have buttons; the other periods are in the chart menu.
  simkl: [
    ...SIMKL_CHART_PERIODS.flatMap((period) =>
      SIMKL_CHART_TYPES.map((type): ConnectionSource => {
        const { noun, defaultDisplayMode, titleType, url } =
          SIMKL_CHART_TYPE_INFO[type];
        return {
          ref: simklTrendingRef(type, period),
          kind: "chart",
          label: `Trending ${noun}${SIMKL_PERIOD_SUFFIX[period]}`,
          defaultDisplayMode,
          ...(titleType ? { titleType } : {}),
          url,
          ...(period === "week" ? {} : { menu: true }),
        };
      }),
    ),
    // The most watched new DVD and Blu-ray releases: movies only.
    {
      ref: "dvd/releases",
      kind: "chart",
      label: "DVD Releases",
      defaultDisplayMode: "movie",
      titleType: "movie",
      url: "https://simkl.com/movies/dvd-releases/",
    },
  ],
};

/** Whether a stored Source list of this Provider must read through a Connection. */
export function sourceRequiresConnection(
  provider: ProviderId,
  ref: string,
): boolean {
  if (PROVIDERS[provider].connection === "required") return true;
  return ref.startsWith("me/");
}

/**
 * The fixed Source list behind a stored reference: one that a Connection
 * unlocks or a public chart of a Provider, or null.
 */
export function staticSource(
  provider: ProviderId,
  ref: string,
): ConnectionSource | null {
  return (
    CONNECTION_SOURCES[provider]?.find((source) => source.ref === ref) ??
    PUBLIC_SOURCES[provider]?.find((source) => source.ref === ref) ??
    null
  );
}

/** What a stored Source list reference tells without reading the Source list. */
interface SourceRefDescription {
  kind: SourceKind;
  /** Short human reference, such as a username or a list ID. */
  detail: string | null;
  /** The Source list page on its Provider, when Stremlist can build it. */
  url: string | null;
  /** A title that the reference suggests, such as a chart name. */
  title?: string;
}

/**
 * One form of the stored references of a Provider: the reverse of its link
 * parser above, for the references that `staticSource` does not know.
 */
interface StoredRefForm {
  pattern: RegExp;
  /**
   * The list type of the form: the reference with its variable parts as
   * `{names}`. See listTypeOf.
   */
  type: string;
  describe: (match: RegExpExecArray) => SourceRefDescription;
}

/**
 * A list of the connected user that the Provider lists for the Account,
 * such as `me/lists/{id}`. It reads as a list named by its reference.
 */
function accountListForm(type: string): StoredRefForm {
  const [prefix] = type.split("{");
  return {
    pattern: new RegExp(`^${prefix}[^/]+$`),
    type,
    describe: ([ref]) => ({ kind: "list", detail: ref, url: null }),
  };
}

const STORED_REF_FORMS: Partial<Record<ProviderId, readonly StoredRefForm[]>> =
  {
    imdb: [
      {
        pattern: IMDB_LIST_ID_PATTERN,
        type: "ls/list",
        describe: ([ref]) => ({
          kind: "list",
          detail: ref,
          url: `https://www.imdb.com/list/${ref}/`,
        }),
      },
      {
        pattern: IMDB_RATINGS_REF_PATTERN,
        type: "ur/ratings",
        describe: ([, user]) => ({
          kind: "list",
          detail: user,
          url: `https://www.imdb.com/user/${user}/ratings`,
          title: "IMDb Ratings",
        }),
      },
      {
        pattern: IMDB_USER_ID_PATTERN,
        type: "ur/watchlist",
        describe: ([ref]) => ({
          kind: "watchlist",
          detail: ref,
          url: `https://www.imdb.com/user/${ref}/watchlist`,
        }),
      },
    ],
    trakt: [
      {
        pattern: /^users\/([^/]+)\/watchlist$/,
        type: "users/{user}/watchlist",
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: `https://trakt.tv/users/${user}/watchlist`,
          title: `${user}'s watchlist`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/lists\/([^/]+)$/,
        type: "users/{user}/lists/{list}",
        describe: ([, user, list]) => ({
          kind: "list",
          detail: `${user}/${list}`,
          url: `https://trakt.tv/users/${user}/lists/${list}`,
        }),
      },
      // One form per Source list of a user, so that each is a list type.
      ...[...TRAKT_USER_SOURCES].map(([source, kind]): StoredRefForm => ({
        pattern: new RegExp(`^users/([^/]+)/${source}$`),
        type: `users/{user}/${source}`,
        describe: ([, user]) => ({
          kind,
          detail: user,
          url: `https://trakt.tv/users/${user}/${source}`,
          title: `${user}'s ${source}`,
        }),
      })),
      {
        pattern: /^lists\/([^/]+)$/,
        type: "lists/{list}",
        describe: ([, list]) => ({
          kind: "list",
          detail: list,
          url: `https://trakt.tv/lists/${list}`,
        }),
      },
      {
        pattern: /^smart-lists\/([^/]+)$/,
        type: "smart-lists/{slug}",
        describe: ([, slug]) => ({
          kind: "list",
          detail: slug,
          url: `https://app.trakt.tv/lists/smart/view/${slug}`,
        }),
      },
      {
        pattern: /^me\/smart-lists\/([^/]+)$/,
        type: "me/smart-lists/{slug}",
        describe: ([, slug]) => ({
          kind: "list",
          detail: "Your account",
          url: `https://app.trakt.tv/lists/smart/view/${slug}`,
        }),
      },
      accountListForm("me/lists/{list}"),
    ],
    simkl: [
      accountListForm("me/lists/{id}"),
      // The month's trending Titles of one genre.
      {
        pattern: SIMKL_GENRE_REF_PATTERN,
        type: "trending/{type}/genre/{slug}",
        describe: ([ref]) => {
          const chart = simklGenreChartOf(ref);
          return {
            kind: "chart",
            detail: null,
            url: chart ? SIMKL_CHART_TYPE_INFO[chart.type].url : null,
            title: chart?.title,
          };
        },
      },
    ],
    mdblist: [
      // Validation stores pasted links as `lists/{id}`, which has no public
      // page; only `lists/{user}/{slug}` maps back to one.
      {
        pattern: /^lists\/([^/]+)$/,
        type: "lists/{id}",
        describe: ([, id]) => ({
          kind: "list",
          detail: `List ${id}`,
          url: null,
        }),
      },
      {
        pattern: /^lists\/([^/]+)\/([^/]+)$/,
        type: "lists/{user}/{slug}",
        describe: ([, user, slug]) => ({
          kind: "list",
          detail: `${user}/${slug}`,
          url: `https://mdblist.com/lists/${user}/${slug}`,
        }),
      },
      {
        pattern: /^watchlist\/([^/]+)$/,
        type: "watchlist/{user}",
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: null,
        }),
      },
      accountListForm("me/lists/{id}"),
      accountListForm("me/external/{id}"),
      // An official chart that CONNECTION_SOURCES does not offer.
      {
        pattern: /^official\/([^/]+)$/,
        type: "official/{slug}",
        describe: ([, slug]) => ({ kind: "chart", detail: slug, url: null }),
      },
    ],
    justwatch: [
      {
        pattern: /^/,
        type: "{list}",
        describe: () => ({ kind: "list", detail: "Shared list", url: null }),
      },
    ],
    senscritique: [
      ...Object.entries(SENSCRITIQUE_COLLECTIONS).map(
        ([name, { action, kind, noun }]): StoredRefForm => ({
          pattern: new RegExp(`^users/([^/]+)/${name}$`),
          type: `users/{user}/${name}`,
          describe: ([, user]) => ({
            kind,
            detail: user,
            url: `https://www.senscritique.com/${user}/collection?action=${action}`,
            title: `${user}'s ${noun}`,
          }),
        }),
      ),
      {
        pattern: /^lists\/([^/]+)$/,
        type: "lists/{id}",
        describe: ([, id]) => ({ kind: "list", detail: id, url: null }),
      },
      {
        pattern: /^polls\/([^/]+)$/,
        type: "polls/{id}",
        describe: ([, id]) => ({ kind: "chart", detail: id, url: null }),
      },
    ],
    letterboxd: [
      {
        // A Share link carries a secret token. Never show the token, the slug,
        // or a clickable URL: only that it is a list shared through a link.
        pattern: /^(?:share|lbxshare|lbxshort)\//,
        type: "share/{token}",
        describe: () => ({ kind: "list", detail: "Shared list", url: null }),
      },
      {
        pattern: /^users\/([^/]+)\/lists\/([^/]+)$/,
        type: "users/{user}/lists/{slug}",
        describe: ([, user, slug]) => ({
          kind: "list",
          detail: `${user}/${slug}`,
          url: `https://letterboxd.com/${user}/list/${slug}/`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/watchlist$/,
        type: "users/{user}/watchlist",
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: `https://letterboxd.com/${user}/watchlist/`,
          title: `${user}'s watchlist`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/diary$/,
        type: "users/{user}/diary",
        describe: ([, user]) => ({
          kind: "history",
          detail: user,
          url: `https://letterboxd.com/${user}/diary/`,
          title: `${user}'s diary`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/films\/rated\/([\d.-]+)$/,
        type: "users/{user}/films/rated/{range}",
        describe: ([, user, rating]) => ({
          kind: "list",
          detail: `${user} ${rating}`,
          url: `https://letterboxd.com/${user}/films/rated/${rating}/`,
          title: `${user}'s films rated ${rating}`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/films$/,
        type: "users/{user}/films",
        describe: ([, user]) => ({
          kind: "list",
          detail: user,
          url: `https://letterboxd.com/${user}/films/`,
          title: `${user}'s films`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/likes\/films$/,
        type: "users/{user}/likes/films",
        describe: ([, user]) => ({
          kind: "list",
          detail: user,
          url: `https://letterboxd.com/${user}/likes/films/`,
          title: `${user}'s liked films`,
        }),
      },
    ],
  };

/**
 * Describe a stored Source list reference: the formats that the link
 * parsers and the source tables above produce. An unknown reference is a
 * list named by its reference.
 */
export function describeSourceRef(
  provider: ProviderId,
  ref: string,
): SourceRefDescription {
  const chart = imdbChartOf({ provider, sourceRef: ref });
  if (chart) {
    return { kind: "chart", detail: null, url: chart.url, title: chart.label };
  }
  const known = staticSource(provider, ref);
  if (known) {
    return {
      kind: known.kind,
      detail: sourceRequiresConnection(provider, ref) ? "Your account" : null,
      url: known.url ?? null,
      title: `${PROVIDERS[provider].label} ${known.label}`,
    };
  }
  for (const form of STORED_REF_FORMS[provider] ?? []) {
    const match = form.pattern.exec(ref);
    if (match) return form.describe(match);
  }
  return { kind: "list", detail: ref, url: null };
}

/**
 * The name of a Source list when its List has no title of its own, such as
 * "IMDb Watchlist", "Simkl Plan to watch" or "Top 250 Movies". The configure
 * page shows it and the manifest names the Catalogs with it.
 */
export function sourceTitle(provider: ProviderId, ref: string): string {
  const { kind, title } = describeSourceRef(provider, ref);
  return title ?? `${PROVIDERS[provider].label} ${SOURCE_KIND_LABELS[kind]}`;
}

/**
 * The list type of a stored Source list reference: what the monitor checks
 * and alerts on, such as `imdb:chart/top-rated-movies`, `trakt:me/history`
 * or `trakt:users/{user}/watchlist`. Each IMDb chart, each fixed Source list
 * and each stored reference form is one type; a reference that none of them
 * knows is `{provider}:other`.
 */
export function listTypeOf(provider: ProviderId, ref: string): string {
  const chart = imdbChartOf({ provider, sourceRef: ref });
  if (chart) return `imdb:chart/${chart.id.slice("imdb:".length)}`;
  if (staticSource(provider, ref)) return `${provider}:${ref}`;
  const form = STORED_REF_FORMS[provider]?.find(({ pattern }) =>
    pattern.test(ref),
  );
  return `${provider}:${form ? form.type : "other"}`;
}

/** Every list type that Stremlist offers, in Provider order. */
export function listTypes(): string[] {
  return PROVIDER_IDS.flatMap((provider) => [
    ...(provider === "imdb"
      ? CHART_REGISTRY.map((chart) => listTypeOf("imdb", chart.id))
      : []),
    ...[
      ...(CONNECTION_SOURCES[provider] ?? []),
      ...(PUBLIC_SOURCES[provider] ?? []),
    ].map((source) => `${provider}:${source.ref}`),
    ...(STORED_REF_FORMS[provider] ?? []).map(
      (form) => `${provider}:${form.type}`,
    ),
  ]);
}
