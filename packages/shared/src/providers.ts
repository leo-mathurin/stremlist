import { isChartId } from "./imdb-charts";

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

export interface ParsedSourceLink extends SourceRef {
  kind: SourceKind;
  /** True when this Source list can only be read through a Connection. */
  requiresConnection: boolean;
  /** Default catalog title suggestion, when the link carries one. */
  suggestedTitle?: string;
}

/** A Source list that becomes available once a Provider is connected. */
export interface ConnectionSource {
  ref: string;
  kind: SourceKind;
  label: string;
  defaultDisplayMode: "split" | "movie" | "series";
}

// ---------------------------------------------------------------------------
// Link parsing
// ---------------------------------------------------------------------------

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function hostIs(url: URL, ...domains: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function segments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

const IMDB_UR = /(?:^|[^a-z0-9])(ur\d{4,})(?![0-9])/i;
const IMDB_LS = /(?:^|[^a-z0-9])(ls\d+)(?![0-9])/i;
const IMDB_P_HANDLE = /(?:^|\/)(p\.[a-zA-Z0-9]+)(?:$|[/?#])/;

function parseImdbLink(input: string): ParsedSourceLink | null {
  const trimmed = input.trim();
  if (isChartId(trimmed)) {
    return { provider: "imdb", ref: trimmed, kind: "chart", requiresConnection: false };
  }
  const url = toUrl(trimmed);
  const isImdbUrl = url !== null && hostIs(url, "imdb.com");
  // Bare IDs (ur…, ls…, p.handle) keep working, as they did before links.
  const bare = !/[/.:]/.test(trimmed.replace(/^p\./, "")) || /^p\.[a-zA-Z0-9]+$/.test(trimmed);
  if (!isImdbUrl && !bare) return null;

  const list = IMDB_LS.exec(trimmed);
  if (list) {
    return { provider: "imdb", ref: list[1].toLowerCase(), kind: "list", requiresConnection: false };
  }
  const user = IMDB_UR.exec(trimmed);
  if (user) {
    return { provider: "imdb", ref: user[1].toLowerCase(), kind: "watchlist", requiresConnection: false };
  }
  const handle = IMDB_P_HANDLE.exec(trimmed);
  if (handle) {
    return { provider: "imdb", ref: handle[1], kind: "watchlist", requiresConnection: false };
  }
  return null;
}

function parseTraktLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "trakt.tv")) return null;
  const parts = segments(url);
  // trakt.tv/users/{user}/watchlist and trakt.tv/users/{user}/lists/{list}
  if (parts[0] === "users" && parts[1]) {
    const user = parts[1].toLowerCase();
    if (parts[2] === "watchlist") {
      return {
        provider: "trakt",
        ref: `users/${user}/watchlist`,
        kind: "watchlist",
        requiresConnection: false,
        suggestedTitle: `${parts[1]}'s watchlist`,
      };
    }
    if (parts[2] === "lists" && parts[3]) {
      return {
        provider: "trakt",
        ref: `users/${user}/lists/${parts[3].toLowerCase()}`,
        kind: "list",
        requiresConnection: false,
      };
    }
  }
  // trakt.tv/lists/{id}: official and shared lists by numeric ID or slug.
  if (parts[0] === "lists" && parts[1]) {
    return { provider: "trakt", ref: `lists/${parts[1].toLowerCase()}`, kind: "list", requiresConnection: false };
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
      ref: `lists/${parts[1]}/${parts[2]}`,
      kind: "list",
      requiresConnection: true,
    };
  }
  // mdblist.com/watchlist/{user}: MDBList only shares the connected user's
  // own watchlist, so the backend turns it into `me/watchlist`.
  if (parts[0] === "watchlist" && parts[1] && parts.length === 2) {
    return {
      provider: "mdblist",
      ref: `watchlist/${parts[1]}`,
      kind: "watchlist",
      requiresConnection: true,
      suggestedTitle: "MDBList watchlist",
    };
  }
  return null;
}

const JUSTWATCH_LIST_ID = /\b(tl-[a-z]{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

function parseJustwatchLink(input: string): ParsedSourceLink | null {
  const trimmed = input.trim();
  const url = toUrl(trimmed);
  const isJustwatch = url !== null && hostIs(url, "justwatch.com");
  if (!isJustwatch && !/^tl-/i.test(trimmed)) return null;
  const match = JUSTWATCH_LIST_ID.exec(trimmed);
  if (!match) return null;
  return { provider: "justwatch", ref: match[1].toLowerCase(), kind: "list", requiresConnection: false };
}

function parseSensCritiqueLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "senscritique.com")) return null;
  const parts = segments(url);
  // senscritique.com/liste/{slug}/{id}
  if (parts[0] === "liste" && parts[1] && /^\d+$/.test(parts[2] ?? "")) {
    return { provider: "senscritique", ref: `lists/${parts[2]}`, kind: "list", requiresConnection: false };
  }
  // senscritique.com/{username}/collection?action=WISH (wishes), or the profile itself.
  const reserved = new Set(["film", "serie", "liste", "search", "recherche", "top", "jeuvideo", "livre", "bd", "album", "morceau"]);
  if (parts[0] && !reserved.has(parts[0].toLowerCase())) {
    return {
      provider: "senscritique",
      ref: `users/${parts[0]}/wishes`,
      kind: "watchlist",
      requiresConnection: false,
      suggestedTitle: `${parts[0]}'s wishlist`,
    };
  }
  return null;
}

function parseLetterboxdLink(input: string): ParsedSourceLink | null {
  const url = toUrl(input);
  if (!url || !hostIs(url, "letterboxd.com", "boxd.it")) return null;
  const parts = segments(url);
  if (parts[0] && parts[1] === "watchlist") {
    return { provider: "letterboxd", ref: `users/${parts[0].toLowerCase()}/watchlist`, kind: "watchlist", requiresConnection: false };
  }
  if (parts[0] && parts[1] === "list" && parts[2]) {
    return { provider: "letterboxd", ref: `users/${parts[0].toLowerCase()}/lists/${parts[2].toLowerCase()}`, kind: "list", requiresConnection: false };
  }
  return { provider: "letterboxd", ref: url.pathname, kind: "list", requiresConnection: false };
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
export const CONNECTION_SOURCES: Partial<Record<ProviderId, ConnectionSource[]>> = {
  trakt: [
    { ref: "me/watchlist", kind: "watchlist", label: "Watchlist", defaultDisplayMode: "split" },
    { ref: "me/recommendations", kind: "recommendations", label: "Recommendations", defaultDisplayMode: "split" },
    { ref: "me/up-next", kind: "up_next", label: "Up Next", defaultDisplayMode: "series" },
    { ref: "me/history", kind: "history", label: "History", defaultDisplayMode: "split" },
    { ref: "me/collection", kind: "collection", label: "Collection", defaultDisplayMode: "split" },
  ],
  simkl: [
    { ref: "me/plantowatch", kind: "watchlist", label: "Plan to watch", defaultDisplayMode: "split" },
    { ref: "me/watching", kind: "status", label: "Watching", defaultDisplayMode: "series" },
    { ref: "me/completed", kind: "status", label: "Completed", defaultDisplayMode: "split" },
    { ref: "me/hold", kind: "status", label: "On hold", defaultDisplayMode: "split" },
    { ref: "me/dropped", kind: "status", label: "Dropped", defaultDisplayMode: "split" },
  ],
  // The user's own lists (`me/lists/{id}`) and external lists
  // (`me/external/{id}`) depend on the account; the backend lists them.
  mdblist: [
    { ref: "me/watchlist", kind: "watchlist", label: "Watchlist", defaultDisplayMode: "split" },
  ],
};

/** Source lists that need no link and no Connection (charts, trending…). */
export const PUBLIC_SOURCES: Partial<Record<ProviderId, ConnectionSource[]>> = {
  trakt: [
    { ref: "trending", kind: "chart", label: "Trending", defaultDisplayMode: "split" },
    { ref: "popular", kind: "chart", label: "Popular", defaultDisplayMode: "split" },
    { ref: "anticipated", kind: "chart", label: "Anticipated", defaultDisplayMode: "split" },
  ],
};

/** Whether a stored Source list of this Provider must read through a Connection. */
export function sourceRequiresConnection(provider: ProviderId, ref: string): boolean {
  if (PROVIDERS[provider].connection === "required") return true;
  return ref.startsWith("me/");
}
