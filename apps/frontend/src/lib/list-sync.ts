import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type { ListSyncStatus } from "@stremlist/shared/sync-status";

/** The Account's Connection with the List's Provider, as far as a List cares. */
export type ListConnectionState = "none" | "ok" | "renew";

/**
 * In a merged List, the Source list that a problem is about, and whether
 * Stremio still shows the Titles of its other Source lists. Absent for a
 * List with one Source list.
 */
interface MergedSourcePart {
  source?: SourceId;
  othersShown?: boolean;
}

/** What the configure page shows for one saved List. */
export type ListSyncState =
  | {
      kind: "waiting";
      reconnected: boolean;
      queue?: { provider: ProviderId; readyAt: string };
    }
  | { kind: "synced"; at: string; titleCount: number | null }
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

function servedSince(status: ListSyncStatus | undefined) {
  if (!status || status.problem === "needs_connection") return null;
  return (status.titleCount ?? 0) > 0 ? status.lastSuccessAt : null;
}

/**
 * The status of the Source list at `index` of a List, from the statuses of
 * the List in `listSources` order. Undefined when the status is about another
 * Source list: the statuses come from the last answer, and a save can change
 * the Source lists of a List before the next answer arrives.
 */
export function statusOfSource(
  statuses: readonly (ListSyncStatus | null)[] | undefined,
  index: number,
  source: SourceId,
) {
  const status = statuses?.[index];
  return status?.provider === source.provider &&
    status.sourceRef === source.sourceRef
    ? status
    : undefined;
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
) {
  const refused = status?.problem === "needs_connection";
  if (connection === "renew" && (requiresConnection || refused)) {
    return {
      kind: "connection",
      renew: true,
      stillShown: servedSince(status) !== null,
    } satisfies ListSyncState;
  }
  if (connection === "none" && requiresConnection) {
    return {
      kind: "connection",
      renew: false,
      stillShown: false,
    } satisfies ListSyncState;
  }
  if (!status)
    return { kind: "waiting", reconnected: false } satisfies ListSyncState;
  if (status.problem === null) {
    return {
      kind: "synced",
      at: status.lastSuccessAt ?? status.lastAttemptAt,
      titleCount: status.titleCount,
    } satisfies ListSyncState;
  }
  if (refused && connection === "ok") {
    return { kind: "waiting", reconnected: true } satisfies ListSyncState;
  }
  return {
    kind: "failing",
    problem: status.problem,
    since: status.failingSince ?? status.lastAttemptAt,
    olderTitlesFrom: servedSince(status),
  } satisfies ListSyncState;
}

function isShown(state: ListSyncState) {
  switch (state.kind) {
    case "synced":
      return true;
    case "connection":
      return state.stillShown;
    case "failing":
      return state.olderTitlesFrom !== null;
    case "waiting":
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
    source: SourceId;
    state: ListSyncState;
  }[],
) {
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
    } satisfies ListSyncState;
  }
  const waiting = parts.flatMap(({ state }) =>
    state.kind === "waiting" ? [state] : [],
  );
  if (waiting.length > 0) {
    return {
      kind: "waiting",
      reconnected: waiting.some((state) => state.reconnected),
    } satisfies ListSyncState;
  }
  const times = parts.flatMap(({ state }) =>
    state.kind === "synced" ? [state.at] : [],
  );
  const oldest = times.reduce((first, at) =>
    Date.parse(at) < Date.parse(first) ? at : first,
  );
  return {
    kind: "synced",
    at: oldest,
    titleCount: null,
  } satisfies ListSyncState;
}

/**
 * How much a List needs the user: "bad" when it does not show in Stremio,
 * "warn" when Stremio shows older Titles, only some of its Source lists, or
 * a Connection is missing, null when nothing is wrong.
 */
export function attentionTone(sync: ListSyncState | null) {
  if (sync?.kind === "connection") {
    return sync.renew && !sync.stillShown && !sync.othersShown ? "bad" : "warn";
  }
  if (sync?.kind === "failing") {
    return sync.olderTitlesFrom || sync.othersShown ? "warn" : "bad";
  }
  return null;
}

/**
 * The color of the dot on a List's sync line: its attention tone when it
 * needs the user, else "ok" once a saved List refreshed, else "idle".
 */
export function syncLineTone(sync: ListSyncState, saved: boolean) {
  return (
    attentionTone(sync) ?? (saved && sync.kind === "synced" ? "ok" : "idle")
  );
}
