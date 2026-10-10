import { useCallback, useEffect, useRef, useState } from "react";
import { listSources, listSourcesKey } from "@stremlist/shared/list-merge";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type {
  ConfigList,
  ConnectionSummary,
} from "@stremlist/shared/stremio.types";
import type { ListSyncStatuses } from "@stremlist/shared/sync-status";
import { api } from "../lib/api";
import type { ListFormRow } from "../lib/list-form";
import { listSyncState, mergedListSyncState } from "../lib/list-sync";
import type { ListConnectionState, ListSyncState } from "../lib/list-sync";

/** How often the page asks for the sync status while a refresh runs. */
const SYNC_POLL_MS = 4000;
/** Stop asking after this many polls (two minutes). */
const SYNC_POLL_LIMIT = 30;

/** The saved Source lists of each saved List. */
type SavedList = Pick<
  ConfigList,
  "id" | "provider" | "sourceRef" | "mergedSources"
>;

/**
 * A server answer with the sync status and the Connections, and the saved
 * Lists when it has them. The staging backend answers without statuses.
 */
interface SyncAnswer {
  syncStatus?: ListSyncStatuses;
  connections: ConnectionSummary[];
  lists?: SavedList[];
}

function sourcesOf(lists: SavedList[]): Record<string, string> {
  return Object.fromEntries(
    lists.map((list) => [list.id, listSourcesKey(list)]),
  );
}

/**
 * The Account's Connections and the sync status of its saved Lists. While a
 * saved List waits for its first refresh (after a save or a new Connection),
 * the page asks the backend for them again. `accountKey` is null and
 * `saved` false on a new setup, which has nothing saved yet.
 */
export function useListSyncStatus(
  accountKey: string | null,
  saved: boolean,
  lists: ListFormRow[],
) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [syncStatus, setSyncStatus] = useState<ListSyncStatuses>({});
  // The saved Source lists by List ID. A row whose Source lists differ (a
  // changed chart, a merge) is not saved yet, so it has no status to wait
  // for.
  const [savedSources, setSavedSources] = useState<Record<string, string>>({});
  // Bumped by every update that does not come from a poll, so a poll that
  // started before it cannot bring older values back.
  const epoch = useRef(0);

  /** Take the statuses and Connections of a config or refresh answer. */
  const applySync = useCallback((answer: SyncAnswer) => {
    epoch.current += 1;
    setConnections(answer.connections);
    setSyncStatus(answer.syncStatus ?? {});
    if (answer.lists) setSavedSources(sourcesOf(answer.lists));
  }, []);

  /** Take the Lists that a save stored. */
  const rememberSaved = useCallback((lists: SavedList[]) => {
    setSavedSources(sourcesOf(lists));
  }, []);

  /** True when the row is a saved List with its saved Source lists. */
  const isSaved = useCallback(
    (row: ListFormRow) =>
      !!row.id && savedSources[row.id] === listSourcesKey(row),
    [savedSources],
  );

  /** Forget a Connection that the user removed. */
  const dropConnection = useCallback((provider: ProviderId) => {
    epoch.current += 1;
    setConnections((current) =>
      current.filter((connection) => connection.provider !== provider),
    );
  }, []);

  /**
   * What a List row shows about its refreshes, from the state of each of its
   * Source lists. Null on a new setup. A row that is not saved, or whose
   * Source lists changed since the save, has no status yet.
   */
  const syncStateOf = useCallback(
    (row: ListFormRow): ListSyncState | null => {
      if (!saved) return null;
      // A saved row reads its saved Source lists, in the order of the
      // statuses.
      const statuses = row.id && isSaved(row) ? syncStatus[row.id] : undefined;
      return mergedListSyncState(
        listSources(row).map((source, index) => {
          const connection = connections.find(
            (c) => c.provider === source.provider,
          );
          const connectionState: ListConnectionState = !connection
            ? "none"
            : connection.needsRenewalSince
              ? "renew"
              : "ok";
          return {
            source,
            state: listSyncState(
              statuses?.[index] ?? undefined,
              connectionState,
              sourceRequiresConnection(source.provider, source.sourceRef),
            ),
          };
        }),
      );
    },
    [saved, connections, syncStatus, isSaved],
  );

  const waitingKey = lists
    .filter((row) => isSaved(row) && syncStateOf(row)?.kind === "waiting")
    .map((row) => row.id)
    .join(",");
  useEffect(() => {
    if (!accountKey || !waitingKey) return;
    let cancelled = false;
    let polls = 0;
    const poll = () => {
      // A hidden tab does not ask (and does not use up the polls); it asks
      // again as soon as it is visible.
      if (document.hidden || polls >= SYNC_POLL_LIMIT) return;
      polls += 1;
      const started = epoch.current;
      api[":accountKey"]["sync-status"]
        .$get({ param: { accountKey } })
        .then(async (res) => {
          if (!res.ok || cancelled) return;
          const body = await res.json();
          if (cancelled || started !== epoch.current) return;
          if (!("syncStatus" in body)) return;
          setSyncStatus(body.syncStatus);
          setConnections((current) =>
            JSON.stringify(current) === JSON.stringify(body.connections)
              ? current
              : body.connections,
          );
        })
        .catch(() => {
          // Try again at the next tick.
        });
    };
    const id = setInterval(poll, SYNC_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [accountKey, waitingKey]);

  return {
    connections,
    syncStateOf,
    isSaved,
    applySync,
    rememberSaved,
    dropConnection,
  };
}
