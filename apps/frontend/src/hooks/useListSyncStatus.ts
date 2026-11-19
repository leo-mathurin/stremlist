import { useCallback, useEffect, useRef, useState } from "react";
import { listSources, listSourcesKey } from "@stremlist/shared/list-merge";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type {
  AccountSyncSnapshot,
  ConfigList,
  ConnectionSummary,
} from "@stremlist/shared/stremio.types";
import type { ListSyncStatuses } from "@stremlist/shared/sync-status";
import { api } from "../lib/api";
import type { ListFormRow } from "../lib/list-form";
import {
  listSyncState,
  mergedListSyncState,
  statusOfSource,
} from "../lib/list-sync";
import type { ListConnectionState } from "../lib/list-sync";

const SYNC_POLL_MS = 4000;
const SYNC_POLL_LIMIT = 30;

type SavedList = Pick<
  ConfigList,
  "id" | "provider" | "sourceRef" | "mergedSources"
>;

interface SyncAnswer {
  syncStatus: ListSyncStatuses;
  connections: ConnectionSummary[];
  readQueue?: ReadQueue;
  lists: SavedList[];
}

type ReadQueue = NonNullable<AccountSyncSnapshot["readQueue"]>;

function sourcesOf(lists: SavedList[]) {
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
  const [readQueue, setReadQueue] = useState<ReadQueue>({});
  const [savedSources, setSavedSources] = useState<Record<string, string>>({});
  const epoch = useRef(0);

  const applySync = useCallback((answer: SyncAnswer) => {
    epoch.current += 1;
    setConnections(answer.connections);
    setSyncStatus(answer.syncStatus);
    setReadQueue(answer.readQueue ?? {});
    setSavedSources(sourcesOf(answer.lists));
  }, []);

  const rememberSaved = (lists: SavedList[]) =>
    setSavedSources(sourcesOf(lists));

  const isSaved = (row: ListFormRow) =>
    !!row.id && savedSources[row.id] === listSourcesKey(row);

  const dropConnection = (provider: ProviderId) => {
    epoch.current += 1;
    setConnections((current) =>
      current.filter((connection) => connection.provider !== provider),
    );
  };

  const syncStateOf = (row: ListFormRow) => {
    if (!saved) return null;
    const statuses = row.id && isSaved(row) ? syncStatus[row.id] : undefined;
    const state = mergedListSyncState(
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
            statusOfSource(statuses, index, source),
            connectionState,
            sourceRequiresConnection(source.provider, source.sourceRef),
          ),
        };
      }),
    );
    const queue = row.id && isSaved(row) ? readQueue[row.id] : undefined;
    return state.kind === "waiting" && queue ? { ...state, queue } : state;
  };

  const waiting = lists.filter(
    (row) => isSaved(row) && syncStateOf(row)?.kind === "waiting",
  );
  const waitingKey = waiting.map((row) => row.id).join(",");
  const queued = waiting.some((row) => row.id && readQueue[row.id]);
  useEffect(() => {
    if (!accountKey || !waitingKey) return;
    let cancelled = false;
    let polls = 0;
    const poll = () => {
      if (document.hidden || polls >= SYNC_POLL_LIMIT) return;
      if (!queued) polls += 1;
      const started = epoch.current;
      api[":accountKey"]["sync-status"]
        .$get({ param: { accountKey } })
        .then(async (res) => {
          if (!res.ok || cancelled) return;
          const body = await res.json();
          if (cancelled || started !== epoch.current) return;
          if (!("syncStatus" in body)) return;
          setSyncStatus(body.syncStatus);
          setReadQueue(body.readQueue ?? {});
          setConnections((current) =>
            JSON.stringify(current) === JSON.stringify(body.connections)
              ? current
              : body.connections,
          );
        })
        .catch(() => {});
    };
    const id = setInterval(poll, SYNC_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [accountKey, waitingKey, queued]);

  return {
    connections,
    syncStateOf,
    isSaved,
    applySync,
    rememberSaved,
    dropConnection,
  };
}
