import {
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import {
  MAX_SOURCES_PER_ACCOUNT,
  MAX_SOURCES_PER_LIST,
  allowedDisplayModes,
  isAddedDateSort,
  listMergeProblem,
  listSources,
  sourceKey,
  sourcesWithoutDates,
} from "@stremlist/shared/list-merge";
import {
  CONNECTION_SOURCES,
  PROVIDER_IDS,
  PROVIDERS,
} from "@stremlist/shared/providers";
import type { ConnectionSource, ProviderId } from "@stremlist/shared/providers";
import type {
  AccountConfigResponse,
  AddonAccess,
  ConfigList,
  ConnectionSummary,
} from "@stremlist/shared/stremio.types";
import { api } from "../lib/api";
import {
  createListRow,
  getListReinstallSignature,
  sourceKeys,
} from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { describeSource } from "../lib/list-sources";

/** Same limit as the backend (`MAX_LISTS`). */
export const MAX_LISTS = 10;

/** The sort a merged List gets when its Source lists have no dates. */
const UNDATED_MERGE_SORT = "title-asc";

/**
 * The row after its Source lists changed: a display mode or a date sort
 * that the merge rules no longer allow falls back to one they allow, and
 * the row explains why next to the control.
 */
function withAllowedSettings(row: ListFormRow): ListFormRow {
  const modes = allowedDisplayModes(row);
  return {
    ...row,
    displayMode: modes.includes(row.displayMode) ? row.displayMode : "split",
    sortOption:
      isAddedDateSort(row.sortOption) && sourcesWithoutDates(row).length > 0
        ? UNDATED_MERGE_SORT
        : row.sortOption,
  };
}

/** The title that a row shows: its own, or the one its Source list suggests. */
export function rowTitle(row: ListFormRow): string {
  return (
    row.catalogTitle.trim() ||
    describeSource(row.provider, row.sourceRef).suggestedTitle
  );
}

/** "new" until the first save creates the Account. */
export type AccountAccess = "new" | AddonAccess;

export type ConfigStatus = {
  type: "success" | "error" | "info";
  message: string;
} | null;

export type ProviderStatus = { enabled: boolean; connectable: boolean };

/** Providers whose Actions an Account can turn on: connected, with Actions. */
export function actionCapableProviders(
  connections: ConnectionSummary[],
): ProviderId[] {
  return PROVIDER_IDS.filter(
    (id) =>
      PROVIDERS[id].actions.length > 0 &&
      connections.some((connection) => connection.provider === id),
  );
}

function defaultProviderStatus(): Record<ProviderId, ProviderStatus> {
  return Object.fromEntries(
    PROVIDER_IDS.map((id) => [
      id,
      { enabled: true, connectable: PROVIDERS[id].connection !== "none" },
    ]),
  ) as Record<ProviderId, ProviderStatus>;
}

/**
 * Source lists that a Connection unlocks, including the account's own lists.
 * Falls back to the static `CONNECTION_SOURCES` when the backend does not
 * answer (or does not have the endpoint yet).
 */
async function fetchConnectionSources(
  accountId: string,
  provider: ProviderId,
): Promise<ConnectionSource[]> {
  const fallback = CONNECTION_SOURCES[provider] ?? [];
  try {
    const res = await api[":accountId"].connections[":provider"].sources.$get({
      param: { accountId, provider },
    });
    if (!res.ok) return fallback;
    const body = await res.json();
    if (!("sources" in body) || body.sources.length === 0) return fallback;
    return body.sources;
  } catch {
    return fallback;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}

function rowsFromLists(lists: ConfigList[]): ListFormRow[] {
  return lists.map((list) =>
    createListRow({
      id: list.id,
      provider: list.provider,
      sourceRef: list.sourceRef,
      catalogTitle: list.catalogTitle,
      sortOption: list.sortOption,
      displayMode: list.displayMode,
      catalogSettings: list.catalogSettings,
      availableGenres: list.availableGenres,
      mergedSources: list.mergedSources,
    }),
  );
}

/**
 * State and server calls of the configure page. `accountKey` is a private
 * Account ID, a Legacy alias, or null for a new setup that is not saved yet.
 */
export function useAccountConfiguration(
  accountKey: string | null,
  options: { onAccountCreated: (accountId: string) => void },
) {
  const { onAccountCreated } = options;
  const [lists, setLists] = useState<ListFormRow[]>([]);
  const [rpdbApiKey, setRpdbApiKey] = useState("");
  const [showRpdbApiKey, setShowRpdbApiKey] = useState(false);
  const [access, setAccess] = useState<AccountAccess>(
    accountKey ? "private" : "new",
  );
  const [accountId, setAccountId] = useState<string | null>(null);
  const [movedAt, setMovedAt] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionSources, setConnectionSources] = useState<
    Partial<Record<ProviderId, ConnectionSource[]>>
  >({});
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [actionOrder, setActionOrder] = useState<ProviderId[]>([]);
  const [actionSelected, setActionSelected] = useState<ProviderId[]>([]);
  const [providerStatus, setProviderStatus] = useState(defaultProviderStatus);
  const [loading, setLoading] = useState(!!accountKey);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(60);
  const [now, setNow] = useState(() => Date.now());
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [showReinstallHint, setShowReinstallHint] = useState(false);
  const [baselineSignature, setBaselineSignature] = useState("");
  // Whether the installed manifest offers Actions (its `stream` resource).
  const [baselineActionsLive, setBaselineActionsLive] = useState<
    boolean | null
  >(null);
  const [status, setStatus] = useState<ConfigStatus>(null);
  const previousKey = useRef(accountKey);
  const currentForm = useRef({ lists, rpdbApiKey });
  // Save responses must see edits committed while the request was in flight.
  useLayoutEffect(() => {
    currentForm.current = { lists, rpdbApiKey };
  }, [lists, rpdbApiKey]);

  useEffect(() => {
    api.providers
      .$get()
      .then((res) => res.json())
      .then((data) => {
        setProviderStatus((current) => {
          const next = { ...current };
          for (const provider of data.providers) {
            next[provider.id] = {
              enabled: provider.enabled,
              connectable: provider.connectable,
            };
          }
          return next;
        });
      })
      .catch(() => {
        // Keep the defaults: the backend still refuses what it cannot do.
      });
  }, []);

  useEffect(() => {
    // A status set while creating the Account (before the key existed) must
    // survive the reload that follows; a switch between Accounts clears it.
    if (previousKey.current !== null) setStatus(null);
    previousKey.current = accountKey;

    setShowReinstallHint(false);
    setBaselineSignature("");
    setBaselineActionsLive(null);
    setNotFound(false);
    setLoadError(false);
    if (!accountKey) {
      setAccess("new");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api[":accountKey"].config
      .$get({ param: { accountKey } })
      .then(async (res) => {
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to load configuration");
        const data = (await res.json()) as AccountConfigResponse;
        if (cancelled) return;
        const rows = rowsFromLists(data.lists);
        setLists(rows);
        setBaselineSignature(getListReinstallSignature(rows));
        setAccess(data.access);
        setAccountId(data.accountId);
        setMovedAt(data.movedAt);
        setRpdbApiKey(data.rpdbApiKey ?? "");
        setConnections(data.connections);
        setLastFetchedAt(data.lastFetchedAt);
        setCooldownSeconds(data.cooldownSeconds);
        setActionsEnabled(data.actions.enabled);
        const capable = actionCapableProviders(data.connections);
        const saved = data.actions.providers.filter((id) =>
          capable.includes(id),
        );
        setActionOrder([
          ...saved,
          ...capable.filter((id) => !saved.includes(id)),
        ]);
        setActionSelected(saved);
        setBaselineActionsLive(data.actions.enabled && saved.length > 0);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey, loadAttempt]);

  // What each Connection unlocks depends on the account (its own lists), so
  // ask the backend once the Connections are known.
  const connectedKey = connections.map((c) => c.provider).join(",");
  useEffect(() => {
    if (!accountId || !connectedKey) {
      setConnectionSources({});
      return;
    }
    let cancelled = false;
    const providers = connectedKey.split(",") as ProviderId[];
    void Promise.all(
      providers.map(
        async (provider) =>
          [
            provider,
            await fetchConnectionSources(accountId, provider),
          ] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setConnectionSources(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, connectedKey]);

  // Tick once a second so the "last refreshed" label and the refresh cooldown
  // countdown stay live without per-event timers.
  useEffect(() => {
    if (!accountKey) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [accountKey]);

  const nextRefreshAt = lastFetchedAt
    ? new Date(lastFetchedAt).getTime() + cooldownSeconds * 1000
    : 0;
  const cooldownRemaining = Math.max(
    0,
    Math.ceil((nextRefreshAt - now) / 1000),
  );
  const onCooldown = cooldownRemaining > 0;

  const setListField = useCallback(
    <K extends keyof ListFormRow>(
      localId: string,
      key: K,
      value: ListFormRow[K],
    ) => {
      setLists((current) =>
        current.map((list) =>
          list.localId === localId ? { ...list, [key]: value } : list,
        ),
      );
    },
    [],
  );

  /**
   * Add a List. Returns an error message when it cannot be added, so the
   * caller can show it next to the control that asked.
   */
  const addList = useCallback(
    (
      partial: Parameters<typeof createListRow>[0],
      current: ListFormRow[],
    ): string | null => {
      if (current.length >= MAX_LISTS) {
        return `You can have at most ${MAX_LISTS} lists.`;
      }
      const used = sourceKeys(current);
      if (used.includes(sourceKey(partial))) {
        return "This list is already in your Stremlist.";
      }
      if (used.length >= MAX_SOURCES_PER_ACCOUNT) {
        return `You can have at most ${MAX_SOURCES_PER_ACCOUNT} Source lists in all your Lists.`;
      }
      setLists((rows) => [...rows, createListRow(partial)]);
      return null;
    },
    [],
  );

  const addChartList = useCallback(
    (chartId: string) => {
      const entry = CHART_BY_ID.get(chartId);
      if (!entry) return;
      addList(
        {
          provider: "imdb",
          sourceRef: entry.id,
          catalogTitle: entry.label,
          displayMode: entry.defaultDisplayMode,
        },
        lists,
      );
    },
    [addList, lists],
  );

  const removeList = useCallback((localId: string) => {
    setLists((current) => current.filter((list) => list.localId !== localId));
  }, []);

  /**
   * Merge the Source lists of another List into a List, after its own. The
   * other List goes away; the target keeps its title and settings.
   */
  const mergeLists = useCallback(
    (targetLocalId: string, otherLocalId: string, current: ListFormRow[]) => {
      const target = current.find((row) => row.localId === targetLocalId);
      const other = current.find((row) => row.localId === otherLocalId);
      if (!target || !other || target === other) return null;
      const merged = [...listSources(target), ...listSources(other)];
      if (merged.length > MAX_SOURCES_PER_LIST) {
        return `A List can merge at most ${MAX_SOURCES_PER_LIST} Source lists.`;
      }
      setLists((rows) =>
        rows.flatMap((row) => {
          if (row.localId === otherLocalId) return [];
          if (row.localId !== targetLocalId) return [row];
          return [
            withAllowedSettings({
              ...row,
              mergedSources: [...row.mergedSources, ...listSources(other)],
            }),
          ];
        }),
      );
      return null;
    },
    [],
  );

  /** Remove one Source list of a merged List; the next one moves up. */
  const removeSource = useCallback((localId: string, index: number) => {
    setLists((rows) =>
      rows.map((row) => {
        const sources = listSources(row);
        if (row.localId !== localId || sources.length < 2) return row;
        const [first, ...rest] = sources.filter((_, i) => i !== index);
        return withAllowedSettings({
          ...row,
          provider: first.provider,
          sourceRef: first.sourceRef,
          mergedSources: rest,
        });
      }),
    );
  }, []);

  /**
   * Take one Source list out of a merged List and give it its own List,
   * just below. Returns an error when the Account has no room for a List.
   */
  const splitSource = useCallback(
    (localId: string, index: number, current: ListFormRow[]) => {
      const row = current.find((item) => item.localId === localId);
      const sources = row ? listSources(row) : [];
      const source = sources.at(index);
      if (!source || sources.length < 2) return null;
      if (current.length >= MAX_LISTS) {
        return `You can have at most ${MAX_LISTS} lists. Remove one to split this List.`;
      }
      removeSource(localId, index);
      const chart =
        source.provider === "imdb"
          ? CHART_BY_ID.get(source.sourceRef)
          : undefined;
      const split = createListRow({
        ...source,
        catalogTitle: describeSource(source.provider, source.sourceRef)
          .suggestedTitle,
        displayMode: chart?.defaultDisplayMode,
      });
      setLists((rows) => {
        const at = rows.findIndex((item) => item.localId === localId);
        return [...rows.slice(0, at + 1), split, ...rows.slice(at + 1)];
      });
      return null;
    },
    [removeSource],
  );

  const reorderLists = useCallback((initialIndex: number, index: number) => {
    setLists((items) => {
      const allDefaultTitles = items.every((list, i) => {
        const title = list.catalogTitle.trim();
        return title === "" || title === String(i + 1);
      });
      const reordered = [...items];
      const [removed] = reordered.splice(initialIndex, 1);
      reordered.splice(index, 0, removed);
      // Numbered default titles follow the position, so drop them and let
      // the backend number the Lists again.
      return allDefaultTitles
        ? reordered.map((list) => ({ ...list, catalogTitle: "" }))
        : reordered;
    });
  }, []);

  const toggleActionProvider = useCallback(
    (provider: ProviderId, selected: boolean) => {
      setActionSelected((current) =>
        selected
          ? [...current.filter((id) => id !== provider), provider]
          : current.filter((id) => id !== provider),
      );
    },
    [],
  );

  const moveActionProvider = useCallback(
    (provider: ProviderId, delta: -1 | 1) => {
      setActionOrder((current) => {
        const index = current.indexOf(provider);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= current.length) {
          return current;
        }
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    [],
  );

  const validationError = (() => {
    if (lists.length > MAX_LISTS) {
      return `You can have at most ${MAX_LISTS} lists.`;
    }
    const keys = sourceKeys(lists);
    if (new Set(keys).size !== keys.length) {
      return "Each list can only be added once.";
    }
    if (keys.length > MAX_SOURCES_PER_ACCOUNT) {
      return `You can have at most ${MAX_SOURCES_PER_ACCOUNT} Source lists in all your Lists.`;
    }
    for (const list of lists) {
      const problem = listMergeProblem(list);
      if (problem) return `${rowTitle(list)}: ${problem}`;
    }
    return null;
  })();

  const listPayload = (rows: ListFormRow[] = lists) =>
    rows.map((list, index) => ({
      id: list.id,
      provider: list.provider,
      sourceRef: list.sourceRef.trim(),
      catalogTitle: list.catalogTitle.trim(),
      sortOption: list.sortOption,
      displayMode: list.displayMode,
      position: index,
      catalogSettings: list.catalogSettings,
      mergedSources: list.mergedSources,
    }));

  /**
   * Create the Account from the current setup. Returns its ID. It may have no
   * Lists yet when it is created to connect a Provider.
   */
  const createAccount = async (): Promise<string | null> => {
    const res = await api.accounts.$post({
      json: { rpdbApiKey, lists: listPayload() },
    });
    const body = await res.json();
    if (!res.ok || !("accountId" in body)) {
      throw new Error(errorMessage(body, "Failed to save your configuration."));
    }
    return body.accountId;
  };

  const handleSave = async () => {
    if (validationError || saving) return;
    if (lists.length === 0) {
      setStatus({ type: "error", message: "Add at least one list first." });
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      if (!accountKey) {
        const created = await createAccount();
        if (created) {
          setStatus({
            type: "success",
            message: "Saved! Install Stremlist in Stremio with your Addon URL.",
          });
          onAccountCreated(created);
        }
        return;
      }

      const currentSignature = getListReinstallSignature(lists);
      // Actions add a `stream` resource to the manifest, which Stremio also
      // reads only at install time.
      const actionsLive =
        access === "private" && actionsEnabled && actionSelected.length > 0;
      const requiresReinstall =
        (baselineSignature.length > 0 &&
          currentSignature !== baselineSignature) ||
        (baselineActionsLive !== null && actionsLive !== baselineActionsLive);

      const submittedLists = lists;
      const submittedPayload = JSON.stringify({
        rpdbApiKey,
        lists: listPayload(submittedLists),
      });
      const res = await api[":accountKey"].config.$post({
        param: { accountKey },
        json: {
          rpdbApiKey,
          lists: listPayload(submittedLists),
          actions:
            access === "private"
              ? {
                  enabled: actionsEnabled,
                  providers: actionOrder.filter((id) =>
                    actionSelected.includes(id),
                  ),
                }
              : undefined,
        },
      });
      const body = await res.json();
      if (!res.ok || !("lists" in body)) {
        throw new Error(errorMessage(body, "Failed to save."));
      }

      const savedRows = submittedLists.map((row, index) => {
        const saved = body.lists[index];
        return saved
          ? {
              ...row,
              id: saved.id,
              sourceRef: saved.sourceRef,
              mergedSources: saved.mergedSources ?? [],
              availableGenres: saved.availableGenres ?? [],
            }
          : row;
      });
      const latest = currentForm.current;
      const hasUnsavedChanges =
        JSON.stringify({
          rpdbApiKey: latest.rpdbApiKey,
          lists: listPayload(latest.lists),
        }) !== submittedPayload;
      // Match rows by their local ID: the user may have added, removed or
      // reordered Lists while the save was in flight.
      const savedByLocalId = new Map(
        savedRows.map((row) => [row.localId, row]),
      );
      const submittedByLocalId = new Map(
        submittedLists.map((row) => [row.localId, row]),
      );
      setLists((current) =>
        current.map((row) => {
          const saved = savedByLocalId.get(row.localId);
          const submitted = submittedByLocalId.get(row.localId);
          if (!saved || !submitted) return row;
          const sourceUnchanged =
            row.sourceRef === submitted.sourceRef &&
            JSON.stringify(row.mergedSources) ===
              JSON.stringify(submitted.mergedSources);
          return {
            ...row,
            id: saved.id,
            sourceRef: sourceUnchanged ? saved.sourceRef : row.sourceRef,
            mergedSources: sourceUnchanged
              ? saved.mergedSources
              : row.mergedSources,
            availableGenres: sourceUnchanged
              ? saved.availableGenres
              : row.availableGenres,
          };
        }),
      );
      setShowReinstallHint(requiresReinstall);
      setBaselineSignature(getListReinstallSignature(savedRows));
      setBaselineActionsLive(actionsLive);
      setStatus({
        type: "success",
        message: hasUnsavedChanges
          ? "Saved the submitted settings. You have unsaved changes: save again to apply them."
          : requiresReinstall
            ? "Saved! Reinstall Stremlist in Stremio to see your new catalogs and Actions."
            : "Saved! Your catalogs will refresh with the new settings.",
      });
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    if (!accountKey || refreshing || onCooldown) return;

    setRefreshing(true);
    setStatus(null);
    try {
      const res = await api[":accountKey"].refresh.$post({
        param: { accountKey },
      });
      const body = await res.json();
      if (!res.ok || !("ok" in body)) {
        throw new Error(errorMessage(body, "Failed to refresh"));
      }
      setCooldownSeconds(body.cooldownSeconds);
      setLastFetchedAt(body.lastFetchedAt);
      if ("lists" in body && body.lists) {
        const refreshed = body.lists;
        setLists((current) =>
          current.map((row) => {
            const match = refreshed.find(
              (list) => list.id === row.id && list.sourceRef === row.sourceRef,
            );
            return match
              ? { ...row, availableGenres: match.availableGenres ?? [] }
              : row;
          }),
        );
      }
      // Success feedback is the live "Last refreshed" label and the cooldown,
      // so only report when some Lists failed.
      if (body.failed > 0) {
        setStatus({
          type: "error",
          message: `Refreshed ${body.refreshed} of ${body.total} lists. Some lists failed to update.`,
        });
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setRefreshing(false);
    }
  };

  /** Give a Legacy alias install a private Addon URL. Returns the new ID. */
  const upgrade = async (): Promise<string | null> => {
    if (!accountKey || access !== "legacy") return null;
    setStatus(null);
    try {
      const res = await api[":accountKey"].upgrade.$post({
        param: { accountKey },
      });
      const body = await res.json();
      if (!res.ok || !("accountId" in body)) {
        throw new Error(
          errorMessage(body, "Failed to create your private URL."),
        );
      }
      return body.accountId;
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
      return null;
    }
  };

  /**
   * Start the OAuth flow of a Provider. A new setup is saved first, because a
   * Connection belongs to an Account.
   */
  const connect = async (provider: ProviderId) => {
    const label = PROVIDERS[provider].label;
    if (access === "legacy") {
      setStatus({
        type: "info",
        message: `To connect ${label}, upgrade this install to a private URL first.`,
      });
      return;
    }
    setConnecting(provider);
    setStatus(null);
    let id = accountId;
    try {
      if (!id) {
        id = await createAccount();
        if (!id) return;
        onAccountCreated(id);
      }
      const res = await api[":accountId"].connections[":provider"].start.$post({
        param: { accountId: id, provider },
      });
      const body = await res.json();
      if (!res.ok || !("authorizeUrl" in body)) {
        throw new Error(
          errorMessage(body, `Could not connect ${label}. Please try again.`),
        );
      }
      window.location.assign(body.authorizeUrl);
    } catch (err) {
      setConnecting(null);
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    }
  };

  /**
   * Read the Connections and Actions again from the server without touching
   * the Lists being edited, so rows show what the backend now serves.
   */
  const refreshAccountState = async (key: string) => {
    try {
      const res = await api[":accountKey"].config.$get({
        param: { accountKey: key },
      });
      if (!res.ok) return;
      const data = (await res.json()) as AccountConfigResponse;
      setConnections(data.connections);
      setLastFetchedAt(data.lastFetchedAt);
      const capable = actionCapableProviders(data.connections);
      setActionOrder((current) => [
        ...current.filter((id) => capable.includes(id)),
        ...capable.filter((id) => !current.includes(id)),
      ]);
      setActionSelected((current) =>
        current.filter((id) => capable.includes(id)),
      );
    } catch {
      // The local state already reflects the disconnect.
    }
  };

  const disconnect = async (provider: ProviderId) => {
    if (!accountId) return;
    const label = PROVIDERS[provider].label;
    setConnecting(provider);
    setStatus(null);
    try {
      const res = await api[":accountId"].connections[":provider"].$delete({
        param: { accountId, provider },
      });
      if (!res.ok) throw new Error(`Could not disconnect ${label}.`);
      setConnections((current) =>
        current.filter((connection) => connection.provider !== provider),
      );
      setActionOrder((current) => current.filter((id) => id !== provider));
      setActionSelected((current) => current.filter((id) => id !== provider));
      setStatus({
        type: "info",
        message: `${label} is disconnected. Lists read through ${label} stop showing in Stremio until you connect it again.`,
      });
      await refreshAccountState(accountId);
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setConnecting(null);
    }
  };

  return {
    lists,
    setListField,
    addList: (partial: Parameters<typeof createListRow>[0]) =>
      addList(partial, lists),
    addChartList,
    removeList,
    mergeLists: (targetLocalId: string, otherLocalId: string) =>
      mergeLists(targetLocalId, otherLocalId, lists),
    removeSource,
    splitSource: (localId: string, index: number) =>
      splitSource(localId, index, lists),
    reorderLists,
    rpdbApiKey,
    setRpdbApiKey,
    showRpdbApiKey,
    setShowRpdbApiKey,
    access,
    accountId,
    movedAt,
    connections,
    connectionSources,
    providerStatus,
    actionsEnabled,
    // Turning Actions on selects every capable Provider, so saving right
    // away gives working Actions.
    setActionsEnabled: (enabled: boolean) => {
      setActionsEnabled(enabled);
      if (enabled) setActionSelected(actionOrder);
    },
    actionOrder,
    actionSelected,
    toggleActionProvider,
    moveActionProvider,
    loading,
    saving,
    refreshing,
    connecting,
    lastFetchedAt,
    cooldownRemaining,
    onCooldown,
    notFound,
    loadError,
    showReinstallHint,
    status,
    setStatus,
    validationError,
    handleSave,
    handleRefresh,
    upgrade,
    connect,
    disconnect,
    retryLoad: () => setLoadAttempt((current) => current + 1),
  };
}
