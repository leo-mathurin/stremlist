import type { ProviderId } from "./providers";
import type { SourceProblemReason } from "./source-problems";

/**
 * The outcome of the latest refreshes of a List: the reads of its Source list
 * on the Provider, by a Stremio request, a save or a manual refresh.
 */
export interface ListSyncStatus {
  /**
   * The Provider of the Source list that was read. Absent from older
   * backends: the Provider of the List's first Source list.
   */
  provider?: ProviderId;
  /** The Source list that was read (a List can change its Source list). */
  sourceRef: string;
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

/**
 * In a merged List, the Source list that a problem is about, and whether
 * Stremio still shows the Titles of its other Source lists. Absent for a
 * List with one Source list.
 */
interface MergedSourcePart {
  source?: { provider: ProviderId; sourceRef: string };
  othersShown?: boolean;
}

/** What the configure page shows for one saved List. */
export type ListSyncState =
  /**
   * Not read yet, or (`reconnected`) failed for want of a Connection that the
   * Account has again: the next read decides.
   */
  | { kind: "waiting"; reconnected: boolean }
  /** `titleCount` is null when unknown, such as for a merged List. */
  | { kind: "synced"; at: string; titleCount: number | null }
  /**
   * The List reads through a Connection that is missing or refused.
   * `stillShown`: Stremio still serves the cached Titles until the next
   * refresh (a refused Connection noticed elsewhere, such as by an Action).
   */
  | ({
      kind: "connection";
      renew: boolean;
      stillShown: boolean;
    } & MergedSourcePart)
  | ({
      kind: "failing";
      problem: SourceProblemReason;
      since: string;
      /**
       * When the Titles that Stremio still shows were refreshed, or null when
       * Stremio shows nothing for this List (or Source list).
       */
      olderTitlesFrom: string | null;
    } & MergedSourcePart);

/**
 * When the Titles that Stremio still serves for this List were refreshed, or
 * null. A List that lost its Connection stops serving its cached Titles.
 */
function servedSince(status: ListSyncStatus | undefined): string | null {
  if (!status || status.problem === "needs_connection") return null;
  return (status.titleCount ?? 0) > 0 ? status.lastSuccessAt : null;
}

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
    return {
      kind: "connection",
      renew: true,
      stillShown: servedSince(status) !== null,
    };
  }
  // A disconnect drops the cached Catalogs of these Lists.
  if (connection === "none" && requiresConnection) {
    return { kind: "connection", renew: false, stillShown: false };
  }
  if (!status) return { kind: "waiting", reconnected: false };
  if (status.problem === null) {
    return {
      kind: "synced",
      at: status.lastSuccessAt ?? status.lastAttemptAt,
      titleCount: status.titleCount,
    };
  }
  // The Provider asked for a Connection that the Account has (again) and
  // that is not refused: the read after the new authorization decides.
  if (refused && connection === "ok") {
    return { kind: "waiting", reconnected: true };
  }
  return {
    kind: "failing",
    problem: status.problem,
    since: status.failingSince ?? status.lastAttemptAt,
    olderTitlesFrom: servedSince(status),
  };
}

/** Whether Stremio shows Titles of a Source list in this state. */
function isShown(state: ListSyncState): boolean {
  switch (state.kind) {
    case "synced":
      return true;
    case "connection":
      return state.stillShown;
    case "failing":
      return state.olderTitlesFrom !== null;
    default:
      return false;
  }
}

/**
 * The state of a List from the states of its Source lists, in the List's
 * order (a List with one Source list keeps its state). A Connection problem
 * of one Source list comes first, then a failed refresh, each with the
 * Source list it is about and whether the others still show. Then a Source
 * list that waits for its first refresh. Otherwise the List is synced as of
 * its oldest refresh; the number of Titles is unknown, because a Title in
 * several Source lists shows once.
 */
export function mergedListSyncState(
  parts: {
    source: { provider: ProviderId; sourceRef: string };
    state: ListSyncState;
  }[],
): ListSyncState {
  if (parts.length === 1) return parts[0].state;
  const problem =
    parts.find(({ state }) => state.kind === "connection") ??
    parts.find(({ state }) => state.kind === "failing");
  if (
    problem &&
    (problem.state.kind === "connection" || problem.state.kind === "failing")
  ) {
    return {
      ...problem.state,
      source: {
        provider: problem.source.provider,
        sourceRef: problem.source.sourceRef,
      },
      othersShown: parts.some(
        (part) => part !== problem && isShown(part.state),
      ),
    };
  }
  const waiting = parts.flatMap(({ state }) =>
    state.kind === "waiting" ? [state] : [],
  );
  if (waiting.length > 0) {
    return {
      kind: "waiting",
      reconnected: waiting.some((state) => state.reconnected),
    };
  }
  const times = parts.flatMap(({ state }) =>
    state.kind === "synced" ? [state.at] : [],
  );
  const oldest = times.reduce((first, at) =>
    Date.parse(at) < Date.parse(first) ? at : first,
  );
  return { kind: "synced", at: oldest, titleCount: null };
}
