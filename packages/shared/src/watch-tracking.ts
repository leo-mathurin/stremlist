import type { ProviderId } from "./providers";

/**
 * Watch tracking (ADR 0003): the Providers that can be a Destination, in the
 * order the configure page shows them.
 */
export const WATCH_PROVIDERS = ["trakt", "simkl", "mdblist"] as const;

export type WatchProviderId = (typeof WATCH_PROVIDERS)[number];

export function isWatchProvider(
  provider: ProviderId | string,
): provider is WatchProviderId {
  return (WATCH_PROVIDERS as readonly string[]).includes(provider);
}

/** Why the last write to a Destination failed, until the next success. */
export type WatchDestinationError =
  /** The Provider does not know the title. */
  | "not_found"
  /** The Connection was refused: connect again. */
  | "needs_renewal"
  /** Writes failed for 72 hours and were dropped. */
  | "gave_up";

export interface WatchedTitleRef {
  imdbId: string;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}

/** A connected Provider that can receive watched titles. */
export interface WatchDestinationStatus {
  provider: WatchProviderId;
  enabled: boolean;
  /**
   * Trakt while Stremio's own Trakt integration is connected: it gets
   * nothing, so a play is never written twice.
   */
  paused: boolean;
  lastTitle: WatchedTitleRef | null;
  lastSuccessAt: string | null;
  lastError: WatchDestinationError | null;
  lastErrorAt: string | null;
  /** Titles waiting for their turn or a retry. */
  pending: number;
}

export interface WatchTrackingStatus {
  /** Watch tracking needs a Stremio link. */
  stremioLinked: boolean;
  /** Stremio's own Trakt integration is connected on the linked account. */
  stremioTrakt: boolean;
  destinations: WatchDestinationStatus[];
}
