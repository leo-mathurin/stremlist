import type { DisplayMode } from "@stremlist/shared/constants";
import type {
  ActionKind,
  ConnectionSource,
  ProviderId,
} from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { StremioMeta } from "@stremlist/shared/stremio.types";

/**
 * IDs that a Provider gives for an entry, used by the ID resolver to find the
 * Title's IMDb ID when the Provider does not give it (ADR 0002).
 */
export interface ExternalIds {
  tmdb?: { id: number; type: "movie" | "series" };
  trakt?: number;
  simkl?: number;
  /** JustWatch title node ID, e.g. "tm92641". */
  justwatch?: string;
  /**
   * JustWatch site path such as "/fr/film/inception", when the Provider links
   * to JustWatch without a node ID (SensCritique).
   */
  justwatchPath?: string;
  /** SensCritique product ID. */
  senscritique?: number;
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
   * The Title's page on the Provider. When set, the catalog description
   * links back to it (Simkl's terms ask for a link on every item).
   */
  sourceUrl?: string;
  /**
   * When the Title joined the Source list (added, watched or collected), as
   * an ISO date. Merged Lists sort their Source lists together by it; set it
   * wherever `sourceHasAddedDates` says the Source list has dates.
   */
  addedAt?: string;
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
  /**
   * False when the read stopped before the end of the Source list (a page or
   * item cap). The entries are still served, but the read is not a complete
   * synchronization, so it never counts for detection (ADR 0007).
   */
  complete: boolean;
}

/** The items of a paginated read, and whether it reached the last page. */
export interface PagedRead<T> {
  items: T[];
  complete: boolean;
}

export type SourceValidation =
  | {
      ok: true;
      /** Normalized reference to store (for example a resolved user ID). */
      ref: string;
      suggestedTitle?: string;
      defaultDisplayMode?: DisplayMode;
    }
  | { ok: false; reason: SourceProblemReason };

/**
 * Thrown when a Source list cannot be read. Every reason except "unavailable"
 * is an expected state that the catalog shows as an information card instead
 * of a server error.
 */
export class SourceUnavailableError extends Error {
  readonly reason: SourceProblemReason;

  constructor(reason: SourceProblemReason, message: string) {
    super(message);
    this.name = "SourceUnavailableError";
    this.reason = reason;
  }
}

/**
 * The Connection cannot give a token any more (refresh refused or revoked):
 * the user must connect the Provider again. Adapters let it through; the
 * services and routes read it as a "needs_connection" Source list.
 */
export class ConnectionExpiredError extends Error {
  readonly provider: ProviderId;

  constructor(provider: ProviderId) {
    super(`The ${provider} connection expired; the user must connect again`);
    this.name = "ConnectionExpiredError";
    this.provider = provider;
  }
}

/** Valid OAuth tokens for one Connection, refreshed when needed. */
export interface ConnectionAccess {
  /**
   * The Account that owns the Connection. Adapters that keep per-Connection
   * state between reads (Simkl's sync snapshot) store it under this ID.
   */
  accountId: string;
  provider: ProviderId;
  username: string | null;
  getAccessToken(): Promise<string>;
  /**
   * The Provider refused the tokens that this access gave: the configure
   * page asks to connect again. Never throws.
   */
  reportRefused(): Promise<void>;
  /** A read that needs the Connection worked with this access. Never throws. */
  reportWorking(): Promise<void>;
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

/** A rating from 1 to 10, the scale of every Provider with ratings. */
export type Rating = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** The value as a Rating, or null when it is not an integer from 1 to 10. */
export function toRating(value: unknown): Rating | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
    ? (value as Rating)
    : null;
}

export type ActionIntent =
  | { kind: "watchlist"; add: boolean }
  | { kind: "watched"; add: boolean }
  /** Null removes the rating. */
  | { kind: "rating"; rating: Rating | null };

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
   * The Provider whose API this strategy calls, if any. The resolver skips
   * the strategy while that Provider's kill switch is on.
   */
  provider?: ProviderId;
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
  /**
   * Check (and normalize) a Source list reference before it is saved. Throws
   * SourceUnavailableError or ConnectionExpiredError like `fetchSource`.
   */
  validateSource(ref: string, ctx: ProviderContext): Promise<SourceValidation>;
  /** Read a Source list. Throws SourceUnavailableError for expected failures. */
  fetchSource(ref: string, ctx: ProviderContext): Promise<SourceSnapshot>;
  /** The resolver cache key for an entry that has no IMDb ID. */
  resolutionKey?(entry: SourceEntry): ResolutionKey | null;
  /** Ordered ID resolution strategies for this Provider's entries. */
  resolverStrategies?: ResolverStrategy[];
  actions?: ProviderActions;
  oauth?: OAuthConfig;
  /**
   * Source lists that this Account's Connection unlocks besides the static
   * CONNECTION_SOURCES (the user's own lists, imported lists…).
   */
  listConnectionSources?(
    connection: ConnectionAccess,
  ): Promise<ConnectionSource[]>;
  /**
   * After a disconnect: forget what the adapter keeps in memory for this
   * Account's Connection. Its R2 objects are deleted with the Connection's
   * prefix.
   */
  forgetConnection?(accountId: string): void;
}
