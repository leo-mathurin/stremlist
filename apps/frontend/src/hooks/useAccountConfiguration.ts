import {
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { toast } from "sonner";
import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
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
  listKey,
} from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { buildAddonUrls } from "../lib/list-sources";
import { reinstallState, requiresReinstall } from "../lib/reinstall";
import type { InstallBaseline } from "../lib/reinstall";

/** Same limit as the backend (`MAX_LISTS`). */
export const MAX_LISTS = 10;

/** "new" until the first save creates the Account. */
export type AccountAccess = "new" | AddonAccess;

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

const UNKNOWN_BASELINE: InstallBaseline = {
  signature: null,
  actionsLive: null,
};

/**
 * What Stremio read at the last install, kept per Account while a reinstall
 * is pending, so the reminder survives a reload.
 */
function installedStorageKey(accountKey: string) {
  return `stremlist:installed:${accountKey}`;
}

function readInstalled(accountKey: string): InstallBaseline | null {
  try {
    const raw = localStorage.getItem(installedStorageKey(accountKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<InstallBaseline>;
    return typeof value.signature === "string" &&
      typeof value.actionsLive === "boolean"
      ? { signature: value.signature, actionsLive: value.actionsLive }
      : null;
  } catch {
    return null;
  }
}

function writeInstalled(accountKey: string, value: InstallBaseline | null) {
  try {
    if (value) {
      localStorage.setItem(
        installedStorageKey(accountKey),
        JSON.stringify(value),
      );
    } else {
      localStorage.removeItem(installedStorageKey(accountKey));
    }
  } catch {
    // Private mode: the reminder lasts until the page closes.
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
  // What Stremio read at the last install, and what the last save serves.
  // They differ until the user reinstalls. Unknown until the configuration
  // loads; the signature is "" for an Account without Lists.
  const [installed, setInstalled] = useState<InstallBaseline>(UNKNOWN_BASELINE);
  const [saved, setSaved] = useState<InstallBaseline>(UNKNOWN_BASELINE);
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
    setInstalled(UNKNOWN_BASELINE);
    setSaved(UNKNOWN_BASELINE);
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
        setAccess(data.access);
        setAccountId(data.accountId);
        setMovedAt(data.movedAt);
        setRpdbApiKey(data.rpdbApiKey ?? "");
        setConnections(data.connections);
        setLastFetchedAt(data.lastFetchedAt);
        setCooldownSeconds(data.cooldownSeconds);
        setActionsEnabled(data.actions.enabled);
        const capable = actionCapableProviders(data.connections);
        const savedProviders = data.actions.providers.filter((id) =>
          capable.includes(id),
        );
        setActionOrder([
          ...savedProviders,
          ...capable.filter((id) => !savedProviders.includes(id)),
        ]);
        setActionSelected(savedProviders);
        const loaded = {
          signature: getListReinstallSignature(rows),
          actionsLive: data.actions.enabled && savedProviders.length > 0,
        };
        setSaved(loaded);
        setInstalled(readInstalled(accountKey) ?? loaded);
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
      if (current.some((row) => listKey(row) === listKey(partial))) {
        return "This list is already in your Stremlist.";
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
    const seen = new Set<string>();
    for (const list of lists) {
      if (seen.has(listKey(list))) {
        return "Each list can only be added once.";
      }
      seen.add(listKey(list));
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

  // Actions add a `stream` resource to the manifest, which Stremio also reads
  // only at install time.
  const actionsLive =
    access === "private" && actionsEnabled && actionSelected.length > 0;
  const reinstall =
    access === "new"
      ? "none"
      : reinstallState(installed, saved, {
          signature: getListReinstallSignature(lists),
          actionsLive,
        });

  /** The user reinstalled: Stremio now reads the saved setup. */
  const markReinstalled = (baseline: InstallBaseline = saved) => {
    setInstalled(baseline);
    if (accountKey) writeInstalled(accountKey, null);
  };

  const handleSave = async () => {
    if (validationError || saving) return;
    if (lists.length === 0) {
      toast.error("Add at least one list first.", { id: "configuration-save" });
      return;
    }

    setSaving(true);
    try {
      if (!accountKey) {
        const created = await createAccount();
        if (created) {
          toast.success(
            "Saved! Install Stremlist in Stremio with your Addon URL.",
            { id: "configuration-save" },
          );
          onAccountCreated(created);
        }
        return;
      }

      const submittedActionsLive = actionsLive;
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
          const sourceUnchanged = row.sourceRef === submitted.sourceRef;
          return {
            ...row,
            id: saved.id,
            sourceRef: sourceUnchanged ? saved.sourceRef : row.sourceRef,
            availableGenres: sourceUnchanged
              ? saved.availableGenres
              : row.availableGenres,
          };
        }),
      );
      const nowSaved = {
        signature: getListReinstallSignature(savedRows),
        actionsLive: submittedActionsLive,
      };
      // Compare with what Stremio read at install time, not with the last
      // save: a reinstall stays needed until the user does it.
      const needsReinstall = requiresReinstall(installed, nowSaved);
      setSaved(nowSaved);
      writeInstalled(accountKey, needsReinstall ? installed : null);
      if (hasUnsavedChanges) {
        toast.success(
          "Saved the submitted settings. You have unsaved changes: save again to apply them.",
          { id: "configuration-save" },
        );
      } else if (needsReinstall) {
        toast.success(
          "Saved! Reinstall Stremlist in Stremio to see your changes.",
          {
            id: "configuration-save",
            duration: 10_000,
            action: {
              label: "Reinstall",
              onClick: () => {
                markReinstalled(nowSaved);
                const { stremioUrl, webUrl } = buildAddonUrls(accountKey);
                if (stremioUrl) window.location.assign(stremioUrl);
                else window.open(webUrl, "_blank", "noopener");
              },
            },
          },
        );
      } else {
        toast.success(
          "Saved! Your catalogs will refresh with the new settings.",
          { id: "configuration-save" },
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong", {
        id: "configuration-save",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    if (!accountKey || refreshing || onCooldown) return;

    setRefreshing(true);
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
        toast.error(
          `Refreshed ${body.refreshed} of ${body.total} lists. Some lists failed to update.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRefreshing(false);
    }
  };

  /** Give a Legacy alias install a private Addon URL. Returns the new ID. */
  const upgrade = async (): Promise<string | null> => {
    if (!accountKey || access !== "legacy") return null;
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
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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
      toast.info(
        `To connect ${label}, upgrade this install to a private URL first.`,
      );
      return;
    }
    setConnecting(provider);
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
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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
      toast.info(
        `${label} is disconnected. Lists read through ${label} stop showing in Stremio until you connect it again.`,
      );
      await refreshAccountState(accountId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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
    reinstall,
    markReinstalled: () => markReinstalled(),
    validationError,
    handleSave,
    handleRefresh,
    upgrade,
    connect,
    disconnect,
    retryLoad: () => setLoadAttempt((current) => current + 1),
  };
}
