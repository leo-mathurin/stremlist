import type { SourceProblemReason } from "./source-problems";

/**
 * The outcome of the latest refreshes of a List: the reads of its Source list
 * on the Provider, by a Stremio request, a save or a manual refresh.
 */
export interface ListSyncStatus {
  /** When Stremlist last tried to read the Source list. */
  lastAttemptAt: string;
  /** When a read last succeeded, or null if none did. */
  lastSuccessAt: string | null;
  /** Titles in the Catalog after the last successful refresh. */
  titleCount: number | null;
  /** Why the last refresh failed, or null when it succeeded. */
  problem: SourceProblemReason | null;
  /** When the current run of failed refreshes started. */
  failingSince: string | null;
}

/** Sync status by List ID. A List that was never read has no entry. */
export type ListSyncStatuses = Record<string, ListSyncStatus>;

/** The Account's Connection with the List's Provider, as far as a List cares. */
export type ListConnectionState =
  /** No Connection with this Provider. */
  | "none"
  /** Connected, and the Provider accepts the Connection. */
  | "ok"
  /** Connected, but the Provider refused the Connection: connect again. */
  | "renew";

/** What the configure page shows for one saved List. */
export type ListSyncState =
  /** Not read yet, or read again after a new Connection. */
  | { kind: "waiting" }
  | { kind: "synced"; at: string; titleCount: number | null }
  /** The List reads through a Connection that is missing or refused. */
  | { kind: "connection"; renew: boolean }
  | {
      kind: "failing";
      problem: SourceProblemReason;
      since: string;
      lastSuccessAt: string | null;
      /** Stremio still shows the Titles of the last successful refresh. */
      showsOlderTitles: boolean;
    };

/**
 * Decide what a List's sync status means for the user.
 *
 * `requiresConnection` is true for Source lists that only a Connection can
 * read. Connection problems come first: they hide the List in Stremio, and
 * connecting again is the only fix.
 */
export function listSyncState(
  status: ListSyncStatus | undefined,
  connection: ListConnectionState,
  requiresConnection: boolean,
): ListSyncState {
  const refused = status?.problem === "needs_connection";
  if (connection === "renew" && (requiresConnection || refused)) {
    return { kind: "connection", renew: true };
  }
  if (connection === "none" && requiresConnection) {
    return { kind: "connection", renew: false };
  }
  if (!status) return { kind: "waiting" };
  if (status.problem === null) {
    return {
      kind: "synced",
      at: status.lastSuccessAt ?? status.lastAttemptAt,
      titleCount: status.titleCount,
    };
  }
  // The Provider asked for a Connection that the Account has (again) and
  // that is not refused: the read after the new authorization decides.
  if (refused && connection === "ok") return { kind: "waiting" };
  return {
    kind: "failing",
    problem: status.problem,
    since: status.failingSince ?? status.lastAttemptAt,
    lastSuccessAt: status.lastSuccessAt,
    // A List that lost its Connection stops serving its cached Titles.
    showsOlderTitles:
      !refused && status.lastSuccessAt !== null && (status.titleCount ?? 0) > 0,
  };
}
