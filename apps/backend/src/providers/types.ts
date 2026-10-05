import type { ActionKind, ProviderId } from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";

/**
 * IDs that a Provider gives for an entry, used by the ID resolver to find the
 * Title's IMDb ID when the Provider does not give it (ADR 0002).
 */
export interface ExternalIds {
  tmdb?: { id: number; type: "movie" | "series" };
  tvdb?: number;
  trakt?: number;
  simkl?: number;
  mal?: number;
  /** JustWatch title node ID, e.g. "tm92641". */
  justwatch?: string;
  /** SensCritique product ID. */
  senscritique?: number;
  letterboxd?: string;
}

/** One entry of a Source list, before ID resolution and enrichment. */
export interface SourceEntry {
  /** The Title's IMDb ID, when the Provider gives it. */
  imdbId?: string;
  externalIds?: ExternalIds;
  type?: "movie" | "series";
  title?: string;
  originalTitle?: string;
  year?: number;
  directors?: string[];
  runtimeMinutes?: number;
  /**
   * Full Stremio metadata, when the Provider already gives everything (IMDb).
   * Entries with `meta` skip the shared enrichment step.
   */
  meta?: StremioMeta;
}

/**
 * The cache key under which the ID resolver remembers an entry's IMDb ID. An
 * entry without one (and without `imdbId`) cannot be resolved.
 */
export interface ResolutionKey {
  namespace: string;
  externalId: string;
}

/** Entries of a Source list, in canonical order: oldest added first. */
export interface SourceSnapshot {
  entries: SourceEntry[];
}

export type SourceValidation =
  | {
      ok: true;
      /** Normalized reference to store (for example a resolved user ID). */
      ref: string;
      suggestedTitle?: string;
      defaultDisplayMode?: "split" | "movie" | "series";
    }
  | { ok: false; reason: SourceUnavailableReason; message?: string };

export type SourceUnavailableReason =
  | "private"
  | "not_found"
  | "needs_connection"
  | "disabled"
  | "coming_soon"
  | "premium_only"
  | "unavailable";

/**
 * Thrown when a Source list cannot be read. Every reason except "unavailable"
 * is an expected state that the catalog shows as an information card instead
 * of a server error.
 */
export class SourceUnavailableError extends Error {
  readonly reason: SourceUnavailableReason;

  constructor(reason: SourceUnavailableReason, message: string) {
    super(message);
    this.name = "SourceUnavailableError";
    this.reason = reason;
  }
}

/** Valid OAuth tokens for one Connection, refreshed when needed. */
export interface ConnectionAccess {
  provider: ProviderId;
  username: string | null;
  getAccessToken(): Promise<string>;
}

export interface ProviderContext {
  /**
   * The Connection to read through, or null. Null for Accounts without a
   * Connection and for requests that come through a Legacy alias.
   */
  connection: ConnectionAccess | null;
}

/** What a Connection's user already has, used to render Action entries. */
export interface Membership {
  /** IMDb IDs in the Provider's watchlist. */
  watchlist: string[];
  /** IMDb IDs of watched movies and of shows with at least one watched episode. */
  watched: string[];
  /** Watched episodes as "tt…:season:episode". */
  watchedEpisodes: string[];
  /** IMDb ID to rating from 1 to 10. */
  ratings: Record<string, number>;
}

export type ActionIntent =
  | { kind: "watchlist"; add: boolean }
  | { kind: "watched"; add: boolean }
  | { kind: "rating"; rating: number | null };

export interface ActionTarget {
  imdbId: string;
  type: "movie" | "series";
  /** For series: the episode, when the Action is about one episode. */
  episode?: { season: number; episode: number };
}

export interface ProviderActions {
  kinds: readonly ActionKind[];
  getMembership(connection: ConnectionAccess): Promise<Membership>;
  perform(
    connection: ConnectionAccess,
    intent: ActionIntent,
    target: ActionTarget,
  ): Promise<void>;
  /**
   * Source list refs whose content an Action of this kind changes, so their
   * cached Catalogs can be marked stale (for example "me/watchlist").
   */
  affectedSources(intent: ActionIntent): string[];
}

/** Turns entries without an IMDb ID into IMDb IDs. See titles/resolver.ts. */
export interface ResolverStrategy {
  name: string;
  /**
   * Resolve the given entries. Returns a map from the entry's index in the
   * input array to its IMDb ID; entries left out stay unresolved.
   */
  resolve(entries: SourceEntry[]): Promise<Map<number, string>>;
}

/** OAuth 2 authorization code flow (with PKCE) for a Provider's Connection. */
export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** Reads the client ID from the environment; undefined = not configured. */
  clientId(): string | undefined;
  clientSecret?(): string | undefined;
  scopes?: string[];
  /** Extra query parameters for the authorize URL. */
  authorizeParams?: Record<string, string>;
  /** Extra headers for token requests (some APIs want their key header). */
  tokenHeaders?(): Record<string, string>;
  /** Revoke a token when the user disconnects (best effort). */
  revoke?(accessToken: string): Promise<void>;
  /** The Provider username to show on the configure page. */
  fetchUsername?(accessToken: string): Promise<string | null>;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** How long a cached Catalog of this Provider stays fresh. */
  freshnessMs: number;
  /**
   * Freshness for one Source list, when it differs by list (for example a
   * public chart read on a shared app quota). Defaults to `freshnessMs`.
   */
  freshnessFor?(ref: string): number;
  /** Check (and normalize) a Source list reference before it is saved. */
  validateSource(ref: string, ctx: ProviderContext): Promise<SourceValidation>;
  /** Read a Source list. Throws SourceUnavailableError for expected failures. */
  fetchSource(ref: string, ctx: ProviderContext): Promise<SourceSnapshot>;
  /** The resolver cache key for an entry that has no IMDb ID. */
  resolutionKey?(entry: SourceEntry): ResolutionKey | null;
  /** Ordered ID resolution strategies for this Provider's entries. */
  resolverStrategies?: ResolverStrategy[];
  actions?: ProviderActions;
  oauth?: OAuthConfig;
}
