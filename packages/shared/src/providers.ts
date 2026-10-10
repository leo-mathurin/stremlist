import type { DisplayMode, TitleType } from "./constants";
import {
  IMDB_LIST_ID_PATTERN,
  IMDB_LS_ID_SOURCE,
  IMDB_P_HANDLE_SOURCE,
  IMDB_UR_ID_SOURCE,
  IMDB_USER_ID_PATTERN,
} from "./constants";
import { imdbChartOf, isChartId } from "./imdb-charts";

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

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  homepage: string;
  /** "soon": shown in the UI, but no Source list can be added yet. */
  availability: "available" | "soon";
  /**
   * "none": public links only. "optional": public links work, a Connection
   * unlocks private Source lists and Actions. "required": every Source list
   * needs a Connection.
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
    id: "imdb",
    label: "IMDb",
    homepage: "https://www.imdb.com",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://www.imdb.com/user/ur12345678/watchlist",
  },
  trakt: {
    id: "trakt",
    label: "Trakt",
    homepage: "https://trakt.tv",
    availability: "available",
    connection: "optional",
    actions: ["watchlist", "watched", "rating"],
    linkExample: "https://trakt.tv/users/username/watchlist",
    // Since 2026-07-22 (docs/providers.md).
    connectNote:
      "A free Trakt account can connect only one app. If Stremio's own Trakt sync uses it, paste public Trakt links instead.",
  },
  simkl: {
    id: "simkl",
    label: "Simkl",
    homepage: "https://simkl.com",
    availability: "available",
    connection: "required",
    actions: ["watchlist", "watched", "rating"],
    linkExample: null,
  },
  mdblist: {
    id: "mdblist",
    label: "MDBList",
    homepage: "https://mdblist.com",
    availability: "available",
    connection: "required",
    actions: ["watchlist", "watched", "rating"],
    linkExample: "https://mdblist.com/lists/username/list-name",
  },
  justwatch: {
    id: "justwatch",
    label: "JustWatch",
    homepage: "https://www.justwatch.com",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://www.justwatch.com/shared?id=tl-us-…",
  },
  senscritique: {
    id: "senscritique",
    label: "SensCritique",
    homepage: "https://www.senscritique.com",
    availability: "available",
    connection: "none",
    actions: [],
    linkExample: "https://www.senscritique.com/username/collection?action=WISH",
  },
  letterboxd: {
    id: "letterboxd",
    label: "Letterboxd",
    homepage: "https://letterboxd.com",
    availability: "soon",
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

export interface SourceRef {
  provider: ProviderId;
  /** A reference that the Provider's adapter understands. */
  ref: string;
}

/**
 * The identity of a Source list, as Lists, statuses and previews name it:
 * its Provider and the reference that the Provider understands.
 */
export interface SourceId {
  provider: ProviderId;
  sourceRef: string;
}

export interface ParsedSourceLink extends SourceRef {
  kind: SourceKind;
  /**
   * True when this Source list can only be read through a Connection. Always
   * `sourceRequiresConnection(provider, ref)`: `parseSourceLink` sets it.
   */
  requiresConnection: boolean;
  /** Default catalog title suggestion, when the link carries one. */
  suggestedTitle?: string;
}

/** What one Provider's link parser finds. */
type LinkMatch = Omit<ParsedSourceLink, "requiresConnection">;

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
}

// ---------------------------------------------------------------------------
// Link parsing
// ---------------------------------------------------------------------------

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

function segments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
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

function parseImdbLink(input: string): LinkMatch | null {
  const trimmed = input.trim();
  if (isChartId(trimmed)) {
    return {
      provider: "imdb",
      ref: trimmed,
      kind: "chart",
    };
  }
  const url = toUrl(trimmed);
  const isImdbUrl = url !== null && hostIs(url, "imdb.com");
  // Bare IDs (ur…, ls…, p.handle) keep working, as they did before links.
  const bare =
    !/[/.:]/.test(trimmed.replace(/^p\./, "")) ||
    /^p\.[a-zA-Z0-9]+$/.test(trimmed);
  if (!isImdbUrl && !bare) return null;

  const list = IMDB_LS.exec(trimmed);
  if (list) {
    return {
      provider: "imdb",
      ref: list[1].toLowerCase(),
      kind: "list",
    };
  }
  const user = IMDB_UR.exec(trimmed);
  if (user) {
    return {
      provider: "imdb",
      ref: user[1].toLowerCase(),
      kind: "watchlist",
    };
  }
  const handle = IMDB_P_HANDLE.exec(trimmed);
  if (handle) {
    return {
      provider: "imdb",
      ref: handle[1],
      kind: "watchlist",
    };
  }
  return null;
}

const TRAKT_CHARTS = ["trending", "popular", "anticipated"] as const;
// trakt.tv/lists/{these} are pages that browse lists, not lists.
const TRAKT_LIST_PAGES = new Set([
  "trending",
  "popular",
  "liked",
  "official",
  "personal",
]);

function parseTraktLink(input: string): LinkMatch | null {
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
        ref: `${owner}/watchlist`,
        kind: "watchlist",
        suggestedTitle: user === "me" ? undefined : `${parts[1]}'s watchlist`,
      };
    }
    if (parts[2] === "lists" && parts[3]) {
      return {
        provider: "trakt",
        ref: `${owner}/lists/${parts[3].toLowerCase()}`,
        kind: "list",
      };
    }
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
      ref: `lists/${parts[2].toLowerCase()}`,
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
      ref: `lists/${parts[1].toLowerCase()}`,
      kind: "list",
    };
  }
  // trakt.tv/movies/trending, trakt.tv/shows/popular…: the chart covers both kinds.
  if ((parts[0] === "movies" || parts[0] === "shows") && parts.length === 2) {
    const chart = TRAKT_CHARTS.find((name) => name === parts[1].toLowerCase());
    if (chart) {
      return {
        provider: "trakt",
        ref: chart,
        kind: "chart",
      };
    }
  }
  return null;
}

function parseMdblistLink(input: string): LinkMatch | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "mdblist.com")) return null;
  const parts = segments(url);
  // mdblist.com/lists/{user}/{slug}: the backend resolves it to `lists/{id}`.
  if (parts[0] === "lists" && parts[1] && parts[2] && parts.length === 3) {
    return {
      provider: "mdblist",
      ref: `lists/${parts[1]}/${parts[2]}`,
      kind: "list",
    };
  }
  // mdblist.com/watchlist/{user}: MDBList only shares the connected user's
  // own watchlist, so the backend turns it into `me/watchlist`.
  if (parts[0] === "watchlist" && parts[1] && parts.length === 2) {
    return {
      provider: "mdblist",
      ref: `watchlist/${parts[1]}`,
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

function parseJustwatchLink(input: string): LinkMatch | null {
  const trimmed = input.trim();
  const url = toUrl(trimmed);
  const isJustwatch = url !== null && hostIs(url, "justwatch.com");
  if (!isJustwatch && !/^tl-/i.test(trimmed)) return null;
  const match = JUSTWATCH_LIST_ID.exec(trimmed);
  if (!match) return null;
  return {
    provider: "justwatch",
    ref: match[1].toLowerCase(),
    kind: "list",
  };
}

function parseSensCritiqueLink(input: string): LinkMatch | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "senscritique.com")) return null;
  const parts = segments(url);
  // senscritique.com/liste/{slug}/{id}
  if (parts[0]?.toLowerCase() === "liste") {
    const id = parts.slice(1).find((part) => /^\d+$/.test(part));
    return id
      ? {
          provider: "senscritique",
          ref: `lists/${id}`,
          kind: "list",
        }
      : null;
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
  // senscritique.com/{username}, or its wishes:
  // /{username}/collection?action=WISH&universe=1. Only wishes are supported,
  // so a collection link with another action ("done", ratings) is rejected.
  const username = parts[0];
  if (!username || reserved.has(username.toLowerCase())) return null;
  if (!/^[\w.-]+$/.test(username)) return null;
  const action = url.searchParams.get("action");
  if (parts[1] === "collection" && action && action.toUpperCase() !== "WISH") {
    return null;
  }
  return {
    provider: "senscritique",
    ref: `users/${username}/wishes`,
    kind: "watchlist",
    suggestedTitle: `${username}'s wishlist`,
  };
}

function parseLetterboxdLink(input: string): LinkMatch | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "letterboxd.com", "boxd.it")) return null;
  const parts = segments(url);
  if (parts[0] && parts[1] === "watchlist") {
    return {
      provider: "letterboxd",
      ref: `users/${parts[0].toLowerCase()}/watchlist`,
      kind: "watchlist",
    };
  }
  if (parts[0] && parts[1] === "list" && parts[2]) {
    return {
      provider: "letterboxd",
      ref: `users/${parts[0].toLowerCase()}/lists/${parts[2].toLowerCase()}`,
      kind: "list",
    };
  }
  return {
    provider: "letterboxd",
    ref: url.pathname,
    kind: "list",
  };
}

const LINK_PARSERS: ((input: string) => LinkMatch | null)[] = [
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
    if (parsed) {
      return {
        ...parsed,
        requiresConnection: sourceRequiresConnection(
          parsed.provider,
          parsed.ref,
        ),
      };
    }
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
      ref: "me/recommendations",
      kind: "recommendations",
      label: "Recommendations",
      defaultDisplayMode: "split",
    },
    // Up Next lists the series in progress (docs/providers.md).
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
  ],
  // The user's own lists (`me/lists/{id}`) and external lists
  // (`me/external/{id}`) depend on the account; the backend lists them.
  mdblist: [
    {
      ref: "me/watchlist",
      kind: "watchlist",
      label: "Watchlist",
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
export interface SourceRefDescription {
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
  describe: (match: RegExpExecArray) => SourceRefDescription;
}

const STORED_REF_FORMS: Partial<Record<ProviderId, readonly StoredRefForm[]>> =
  {
    imdb: [
      {
        pattern: IMDB_LIST_ID_PATTERN,
        describe: ([ref]) => ({
          kind: "list",
          detail: ref,
          url: `https://www.imdb.com/list/${ref}/`,
        }),
      },
      {
        pattern: IMDB_USER_ID_PATTERN,
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
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: `https://trakt.tv/users/${user}/watchlist`,
          title: `${user}'s watchlist`,
        }),
      },
      {
        pattern: /^users\/([^/]+)\/lists\/([^/]+)$/,
        describe: ([, user, list]) => ({
          kind: "list",
          detail: `${user}/${list}`,
          url: `https://trakt.tv/users/${user}/lists/${list}`,
        }),
      },
      {
        pattern: /^lists\/([^/]+)$/,
        describe: ([, list]) => ({
          kind: "list",
          detail: list,
          url: `https://trakt.tv/lists/${list}`,
        }),
      },
    ],
    mdblist: [
      // Validation stores pasted links as `lists/{id}`, which has no public
      // page; only `lists/{user}/{slug}` maps back to one.
      {
        pattern: /^lists\/([^/]+)$/,
        describe: ([, id]) => ({
          kind: "list",
          detail: `List ${id}`,
          url: null,
        }),
      },
      {
        pattern: /^lists\/([^/]+)\/([^/]+)$/,
        describe: ([, user, slug]) => ({
          kind: "list",
          detail: `${user}/${slug}`,
          url: `https://mdblist.com/lists/${user}/${slug}`,
        }),
      },
      {
        pattern: /^watchlist\/([^/]+)$/,
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: null,
        }),
      },
    ],
    justwatch: [
      {
        pattern: /^/,
        describe: () => ({ kind: "list", detail: "Shared list", url: null }),
      },
    ],
    senscritique: [
      {
        pattern: /^users\/([^/]+)\/wishes$/,
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: `https://www.senscritique.com/${user}/collection?action=WISH`,
          title: `${user}'s wishlist`,
        }),
      },
      {
        pattern: /^lists\/([^/]+)$/,
        describe: ([, id]) => ({ kind: "list", detail: id, url: null }),
      },
    ],
    letterboxd: [
      {
        pattern: /^users\/([^/]+)\/watchlist$/,
        describe: ([, user]) => ({
          kind: "watchlist",
          detail: user,
          url: null,
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

/** What a stored Source list is on its Provider. */
export function storedSourceKind(
  provider: ProviderId,
  ref: string,
): SourceKind {
  return describeSourceRef(provider, ref).kind;
}
