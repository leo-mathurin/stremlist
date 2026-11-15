import {
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { toast } from "sonner";
import { listSourcesKey } from "@stremlist/shared/list-merge";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type {
  AccountConfigResponse,
  ConfigList,
  ConnectionSummary,
  NewTitlesSummary,
  StremioLink,
} from "@stremlist/shared/stremio.types";
import {
  configBody,
  hasUnsavedChanges,
  reconcileActionProviders,
} from "../lib/account-config";
import type {
  AccountAccess,
  AccountForm,
  ActionProviders,
} from "../lib/account-config";
import { api } from "../lib/api";
import {
  connectProviderOf,
  dropDraft,
  keepDraft,
  missingConnections,
  readDraft,
  rememberConnectStart,
  takeDraft,
} from "../lib/connections";
import { rowsFromLists } from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { buildAddonUrls } from "../lib/list-sources";
import { ACTION_PROVIDERS } from "../lib/provider-groups";
import { useConnectionSources } from "./useConnectionSources";
import { useListEditor } from "./useListEditor";
import { useListSyncStatus } from "./useListSyncStatus";
import { useProviderStatus } from "./useProviderStatus";
import { useReinstallBaseline } from "./useReinstallBaseline";
import type { InstallSetup } from "./useReinstallBaseline";
import { STREMIO_UPDATE_TOAST, useStremioSync } from "./useStremioSync";

/** The Lists that a save stored, in the order it got them. */
type StoredLists = Pick<
  ConfigList,
  "id" | "provider" | "sourceRef" | "mergedSources" | "availableGenres"
>[];

/** Providers whose Actions an Account can turn on: connected, with Actions. */
function actionCapableProviders(
  connections: ConnectionSummary[],
): ProviderId[] {
  return ACTION_PROVIDERS.filter((id) =>
    connections.some((connection) => connection.provider === id),
  );
}

function errorMessage<Body extends object>(
  body: Body,
  fallback: string,
): string {
  return "error" in body &&
    typeof body.error === "string" &&
    body.error.length > 0
    ? body.error
    : fallback;
}

function toastError(err: unknown, options?: { id: string }) {
  toast.error(
    err instanceof Error ? err.message : "Something went wrong",
    options,
  );
}

/** What a new setup starts with: a form with this content has nothing to lose. */
const EMPTY_FORM: AccountForm = {
  lists: [],
  rpdbApiKey: "",
  actionsEnabled: false,
  actions: { order: [], selected: [] },
  newTitlesEnabled: false,
};

/**
 * The saved form, with its Actions fitted to the Providers that can have
 * Actions now, as the page fits the edited form.
 */
function reconcileSavedActions(
  saved: AccountForm,
  capable: ProviderId[],
): AccountForm {
  return {
    ...saved,
    actions: reconcileActionProviders(
      saved.actions.order,
      saved.actions.selected,
      capable,
    ),
  };
}

/**
 * The configuration of an Account, "notFound", or null when it cannot be
 * read (an answer without Lists included).
 */
async function fetchConfig(
  accountKey: string,
): Promise<AccountConfigResponse | "notFound" | null> {
  const res = await api[":accountKey"].config.$get({ param: { accountKey } });
  if (res.status === 404) return "notFound";
  if (!res.ok) return null;
  const body = await res.json();
  return "lists" in body ? body : null;
}

/**
 * Create an Account from `form`. It may have no Lists yet when it is created
 * to connect a Provider.
 */
async function postNewAccount(form: AccountForm) {
  const res = await api.accounts.$post({ json: configBody(form, "new") });
  const body = await res.json();
  if (!res.ok || !("accountId" in body)) {
    throw new Error(errorMessage(body, "Failed to save your configuration."));
  }
  return body;
}

/** Save `form` to an existing Account. Returns what the save stored. */
async function postConfig(
  accountKey: string,
  form: AccountForm,
  access: AccountAccess,
) {
  const res = await api[":accountKey"].config.$post({
    param: { accountKey },
    json: configBody(form, access),
  });
  const body = await res.json();
  if (!res.ok || !("lists" in body)) {
    throw new Error(errorMessage(body, "Failed to save."));
  }
  return body;
}

/** Ask the backend to read the Lists of an Account again. */
async function postRefresh(accountKey: string) {
  const res = await api[":accountKey"].refresh.$post({
    param: { accountKey },
  });
  const body = await res.json();
  if (!res.ok || !("ok" in body)) {
    throw new Error(errorMessage(body, "Failed to refresh"));
  }
  return body;
}

/** Start the OAuth flow of a Provider, for an Account or a new setup. */
async function postConnectStart(
  accountId: string | null,
  provider: ProviderId,
  label: string,
) {
  const res = accountId
    ? await api[":accountId"].connections[":provider"].start.$post({
        param: { accountId, provider },
      })
    : await api.connections[":provider"].start.$post({
        param: { provider },
      });
  const body = await res.json();
  if (!res.ok || !("authorizeUrl" in body)) {
    throw new Error(
      errorMessage(body, `Could not connect ${label}. Please try again.`),
    );
  }
  return body;
}

async function deleteConnection(
  accountId: string,
  provider: ProviderId,
  label: string,
): Promise<void> {
  const res = await api[":accountId"].connections[":provider"].$delete({
    param: { accountId, provider },
  });
  if (!res.ok) throw new Error(`Could not disconnect ${label}.`);
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
  const editor = useListEditor();
  const { lists, setLists } = editor;
  const [rpdbApiKey, setRpdbApiKey] = useState("");
  const [access, setAccess] = useState<AccountAccess>(
    accountKey ? "private" : "new",
  );
  const [accountId, setAccountId] = useState<string | null>(null);
  /**
   * The private Account that this page just made from a Legacy alias
   * install. The old page then stops editing: the user leaves that install.
   */
  const [upgradedTo, setUpgradedTo] = useState<string | null>(null);
  const {
    connections,
    syncStateOf,
    isSaved,
    applySync,
    rememberSaved,
    dropConnection,
  } = useListSyncStatus(accountKey, access !== "new", lists);
  const connectionSources = useConnectionSources(accountId, connections);
  const providerStatus = useProviderStatus();
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [actions, setActions] = useState<ActionProviders>({
    order: [],
    selected: [],
  });
  const [newTitlesEnabled, setNewTitlesEnabled] = useState(false);
  const [newTitlesSummary, setNewTitlesSummary] =
    useState<NewTitlesSummary | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "notFound" | "error"
  >(accountKey ? "loading" : "ready");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(60);
  const nextRefreshAt = lastFetchedAt
    ? new Date(lastFetchedAt).getTime() + cooldownSeconds * 1000
    : 0;
  const baseline = useReinstallBaseline(accountKey);
  const { reset: resetBaseline, onLoaded: onBaselineLoaded } = baseline;
  // Optional: a linked Stremio account turns the reinstall into an update.
  const [loadedStremio, setLoadedStremio] = useState<StremioLink | null>(null);
  const stremio = useStremioSync(
    access === "private" ? accountId : null,
    loadedStremio,
    baseline.markReinstalled,
  );
  /**
   * The Account that the first save just created, with what it stored. The
   * page already shows that setup, so loading the Account must not replace
   * it with a loader.
   */
  const created = useRef<{ accountId: string; setup: InstallSetup } | null>(
    null,
  );

  const form: AccountForm = {
    lists,
    rpdbApiKey,
    actionsEnabled,
    actions,
    newTitlesEnabled,
  };
  /**
   * The form as the server last stored it, or null until it is known. The
   * page has unsaved changes when the form differs from it.
   */
  const [savedForm, setSavedForm] = useState<AccountForm | null>(null);
  /**
   * The Account key whose state the page shows. Undefined before the first
   * render, so that the first render sets up the state too.
   */
  const [shownKey, setShownKey] = useState<string | null | undefined>(
    undefined,
  );
  /** The Account that the first save just created, until the key moves on. */
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  // Another Account key: what the page shows belongs to the old one. The
  // Account that the first save created keeps its form on screen: only the
  // server state loads.
  if (shownKey !== accountKey) {
    setShownKey(accountKey);
    if (!accountKey) {
      setAccess("new");
      setSavedForm(EMPTY_FORM);
      // Back from a connect that did not complete: the setup it took along.
      // The effect below forgets it once this render commits.
      const draft = readDraft(null);
      if (draft) {
        setLists(draft.lists);
        setRpdbApiKey(draft.rpdbApiKey);
        setNewTitlesEnabled(draft.newTitlesEnabled);
      }
      setStatus("ready");
    } else if (accountKey !== createdKey) {
      setStatus("loading");
      setSavedForm(null);
    }
    if (accountKey !== createdKey) setCreatedKey(null);
  }
  const currentForm = useRef(form);
  // Save responses must see edits committed while the request was in flight.
  useLayoutEffect(() => {
    currentForm.current = form;
  });

  /**
   * Take what the server says about the Account and the page does not edit:
   * the sync status, Connections, refresh times, the New titles summary, and
   * the Providers that can have Actions.
   */
  const applyServerState = useCallback(
    (data: AccountConfigResponse) => {
      applySync(data);
      setLastFetchedAt(data.lastFetchedAt);
      setCooldownSeconds(data.cooldownSeconds);
      setNewTitlesSummary(data.newTitles.summary);
      const capable = actionCapableProviders(data.connections);
      setActions((current) =>
        reconcileActionProviders(current.order, current.selected, capable),
      );
      setSavedForm((saved) => saved && reconcileSavedActions(saved, capable));
    },
    [applySync],
  );

  useEffect(() => {
    resetBaseline();
    if (!accountKey) {
      // The render took the draft of the new setup, if any.
      dropDraft();
      return;
    }

    let cancelled = false;
    const justCreated =
      created.current?.accountId === accountKey ? created.current : null;
    fetchConfig(accountKey)
      .then((data) => {
        if (cancelled) return;
        created.current = null;
        if (data === "notFound") {
          setStatus("notFound");
          return;
        }
        if (!data) throw new Error("Failed to load configuration");
        if (justCreated) {
          applyServerState(data);
          onBaselineLoaded(accountKey, data.lists, justCreated.setup);
          return;
        }
        const rows = rowsFromLists(data.lists);
        const capable = actionCapableProviders(data.connections);
        // The saved Actions Providers first, in their order.
        const saved = reconcileActionProviders(
          data.actions.providers,
          data.actions.providers,
          capable,
        );
        const storedForm: AccountForm = {
          lists: rows,
          rpdbApiKey: data.rpdbApiKey ?? "",
          actionsEnabled: data.actions.enabled,
          actions: saved,
          newTitlesEnabled: data.newTitles.enabled,
        };
        // Back from Connect: the edits the user had not saved yet.
        const draft = data.accountId ? takeDraft(data.accountId) : null;
        const restored =
          draft && hasUnsavedChanges(storedForm, draft, data.access)
            ? {
                ...draft,
                actions: reconcileActionProviders(
                  draft.actions.order,
                  draft.actions.selected,
                  capable,
                ),
              }
            : null;
        const shown = restored ?? storedForm;
        setSavedForm(storedForm);
        setLists(shown.lists);
        setAccess(data.access);
        setAccountId(data.accountId);
        setLoadedStremio(data.stremio);
        setRpdbApiKey(shown.rpdbApiKey);
        setActionsEnabled(shown.actionsEnabled);
        setActions(shown.actions);
        setNewTitlesEnabled(shown.newTitlesEnabled);
        applyServerState(data);
        if (restored) {
          toast.info("Your unsaved changes are back. Save to apply them.", {
            id: "configuration-draft",
          });
        }
        onBaselineLoaded(accountKey, data.lists, {
          rows,
          newTitles: data.newTitles.enabled,
          actionsLive: data.actions.enabled && saved.selected.length > 0,
        });
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        created.current = null;
        // The new Account is saved and on screen: without its server state,
        // the rows only show no sync status.
        if (!justCreated) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [
    accountKey,
    loadAttempt,
    resetBaseline,
    onBaselineLoaded,
    applyServerState,
    setLists,
  ]);

  // Actions add a `stream` resource to the manifest, which Stremio also reads
  // only at install time.
  const actionsLive =
    access === "private" && actionsEnabled && actions.selected.length > 0;
  const reinstall =
    access === "new"
      ? "none"
      : baseline.stateFor({
          rows: lists,
          newTitles: newTitlesEnabled,
          actionsLive,
        });

  /**
   * Give the submitted rows the IDs and Source lists that the save stored.
   * Returns the saved rows.
   */
  const adoptStoredLists = (submitted: ListFormRow[], stored: StoredLists) => {
    rememberSaved(stored);
    const savedRows = submitted.map((row, index) => {
      const saved = stored[index];
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
    // Match rows by their local ID: the user may have added, removed or
    // reordered Lists while the save was in flight.
    const savedByLocalId = new Map(savedRows.map((row) => [row.localId, row]));
    const submittedByLocalId = new Map(
      submitted.map((row) => [row.localId, row]),
    );
    setLists((current) =>
      current.map((row) => {
        const saved = savedByLocalId.get(row.localId);
        const before = submittedByLocalId.get(row.localId);
        if (!saved || !before) return row;
        const sourceUnchanged = listSourcesKey(row) === listSourcesKey(before);
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
    return savedRows;
  };

  const saveNewAccount = async (submitted: AccountForm) => {
    const body = await postNewAccount(submitted);
    const savedRows = adoptStoredLists(submitted.lists, body.lists);
    setSavedForm({ ...submitted, lists: savedRows });
    created.current = {
      accountId: body.accountId,
      setup: {
        rows: savedRows,
        newTitles: submitted.newTitlesEnabled,
        actionsLive: false,
      },
    };
    setCreatedKey(body.accountId);
    // Show the Account at once; its server state loads in the background.
    setAccess("private");
    setAccountId(body.accountId);
    toast.success("Saved! Install Stremlist in Stremio with your Addon URL.", {
      id: "configuration-save",
    });
    onAccountCreated(body.accountId);
  };

  const saveAccount = async (accountKey: string, submitted: AccountForm) => {
    const body = await postConfig(accountKey, submitted, access);

    const unsaved = hasUnsavedChanges(submitted, currentForm.current, access);
    const savedRows = adoptStoredLists(submitted.lists, body.lists);
    setSavedForm({ ...submitted, lists: savedRows });
    const { needsReinstall } = baseline.onSaved(accountKey, body.lists, {
      rows: savedRows,
      newTitles: submitted.newTitlesEnabled,
      actionsLive,
    });
    // The saved Lists change what the summary counts.
    setNewTitlesSummary(body.newTitles);
    if (unsaved) {
      toast.success(
        "Saved the submitted settings. You have unsaved changes: save again to apply them.",
        { id: "configuration-save" },
      );
    } else if (needsReinstall && stremio.connection) {
      // The update result replaces this toast.
      toast.dismiss("configuration-save");
      toast.success("Saved! Stremlist is updating Stremio.", {
        id: STREMIO_UPDATE_TOAST,
      });
    } else if (
      needsReinstall &&
      stremio.available &&
      !stremio.manualPreferred
    ) {
      // The reminder on the page offers both ways to update Stremio.
      toast.success("Saved! Choose how Stremio gets your changes.", {
        id: "configuration-save",
        action: null,
      });
    } else if (needsReinstall) {
      toast.success(
        "Saved! Reinstall Stremlist in Stremio to see your changes.",
        {
          id: "configuration-save",
          duration: 10_000,
          action: {
            label: "Reinstall",
            // The reinstall takes the link twice (Uninstall, then
            // Install), so the reminder stays until "I did it".
            onClick: () => {
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
    // Also with edits made during the save: Stremio gets what was saved.
    if (needsReinstall && stremio.connection) void stremio.update();
  };

  const handleSave = async () => {
    if (editor.validationError || saving) return;
    if (lists.length === 0) {
      toast.error("Add at least one list first.", { id: "configuration-save" });
      return;
    }

    setSaving(true);
    const submitted = form;
    try {
      if (accountKey) await saveAccount(accountKey, submitted);
      else await saveNewAccount(submitted);
    } catch (err) {
      toastError(err, { id: "configuration-save" });
    }
    setSaving(false);
  };

  const handleRefresh = async () => {
    if (!accountKey || refreshing || Date.now() < nextRefreshAt) return;

    setRefreshing(true);
    try {
      const body = await postRefresh(accountKey);
      setCooldownSeconds(body.cooldownSeconds);
      setLastFetchedAt(body.lastFetchedAt);
      // A throttled refresh read nothing new.
      if ("syncStatus" in body) applySync(body);
      if ("newTitles" in body) setNewTitlesSummary(body.newTitles);
      if ("lists" in body) {
        const refreshed = body.lists;
        setLists((current) =>
          current.map((row) => {
            const match = refreshed.find(
              (list) =>
                list.id === row.id &&
                listSourcesKey(row) === listSourcesKey(list),
            );
            return match
              ? { ...row, availableGenres: match.availableGenres ?? [] }
              : row;
          }),
        );
      }
      // Success feedback is the live "Last refreshed" label and the cooldown,
      // so only report when some Lists failed. Each failed List says why.
      if (body.failed > 0) {
        toast.error(
          `Refreshed ${body.refreshed} of ${body.total} lists. The others failed to update: each list shows why.`,
        );
      }
    } catch (err) {
      toastError(err);
    }
    setRefreshing(false);
  };

  /**
   * Give a Legacy alias install a private Addon URL: a new Account with the
   * setup that this page shows, unsaved edits included. The legacy install
   * stays as it is, because its `ur…` ID is public (ADR 0001). Returns the
   * new ID.
   */
  const upgrade = async (): Promise<string | null> => {
    if (!accountKey || access !== "legacy") return null;
    try {
      const { accountId: id } = await postNewAccount(form);
      setUpgradedTo(id);
      return id;
    } catch (err) {
      toastError(err);
      return null;
    }
  };

  /**
   * Start the OAuth flow of a Provider. A Connection belongs to an Account:
   * a new setup gets its Account only when the connection succeeds, with the
   * setup kept here, so a cancelled connect leaves nothing behind.
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
    // Leaving for the Provider reloads the page: keep the unsaved edits.
    keepDraft(accountId, form);
    try {
      const body = await postConnectStart(accountId, provider, label);
      rememberConnectStart({
        provider,
        accountId,
        browserKey: body.browserKey,
      });
      window.location.assign(body.authorizeUrl);
    } catch (err) {
      dropDraft();
      setConnecting(null);
      toastError(err);
    }
  };

  const disconnect = async (provider: ProviderId) => {
    if (!accountId) return;
    const label = PROVIDERS[provider].label;
    setConnecting(provider);
    try {
      await deleteConnection(accountId, provider, label);
      dropConnection(provider);
      const capable = actionCapableProviders(
        connections.filter((connection) => connection.provider !== provider),
      );
      setActions((current) =>
        reconcileActionProviders(current.order, current.selected, capable),
      );
      setSavedForm((saved) => saved && reconcileSavedActions(saved, capable));
      toast.info(
        `${label} is disconnected. Lists read through ${label} stop showing in Stremio until you connect it again.`,
      );
      // Read the server state again without touching the Lists being
      // edited, so rows show what the backend now serves. When it cannot be
      // read, the local state already reflects the disconnect.
      const data = await fetchConfig(accountId).catch(() => null);
      if (data && data !== "notFound") applyServerState(data);
    } catch (err) {
      toastError(err);
    }
    setConnecting(null);
  };

  /** What a List row shows about its refreshes and Connections. */
  const rowModel = (list: ListFormRow) => {
    const sync = syncStateOf(list);
    const missing =
      access === "private" ? missingConnections(list, connections) : [];
    return {
      sync,
      missing,
      connectProvider: connectProviderOf(list, sync, missing),
      saved: isSaved(list),
    };
  };

  /** The form has changes that a save would send. */
  const dirty =
    savedForm !== null && hasUnsavedChanges(savedForm, form, access);

  return {
    ...editor,
    dirty,
    /**
     * A save has work to do: the form has changes, or the page asks to
     * save, then reinstall (a disconnect turned Actions off without an edit).
     */
    saveNeeded: dirty || reinstall === "after-save",
    rpdbApiKey,
    setRpdbApiKey,
    access,
    accountId,
    upgradedTo,
    connections,
    connectionSources,
    providerStatus,
    rowModel,
    actionsEnabled,
    // Turning Actions on selects every capable Provider, so saving right
    // away gives working Actions.
    setActionsEnabled: (enabled: boolean) => {
      setActionsEnabled(enabled);
      if (enabled) {
        setActions((current) => ({ ...current, selected: current.order }));
      }
    },
    actionOrder: actions.order,
    actionSelected: actions.selected,
    toggleActionProvider: (provider: ProviderId, selected: boolean) =>
      setActions((current) => ({
        ...current,
        selected: selected
          ? [...current.selected.filter((id) => id !== provider), provider]
          : current.selected.filter((id) => id !== provider),
      })),
    moveActionProvider: (provider: ProviderId, delta: -1 | 1) =>
      setActions((current) => {
        const index = current.order.indexOf(provider);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= current.order.length) {
          return current;
        }
        const order = [...current.order];
        [order[index], order[target]] = [order[target], order[index]];
        return { ...current, order };
      }),
    newTitlesEnabled,
    setNewTitlesEnabled,
    newTitlesSummary,
    status,
    saving,
    refreshing,
    connecting,
    lastFetchedAt,
    nextRefreshAt,
    reinstall,
    markReinstalled: baseline.markReinstalled,
    stremio,
    handleSave,
    handleRefresh,
    upgrade,
    connect,
    disconnect,
    retryLoad: () => {
      setStatus("loading");
      setSavedForm(null);
      setLoadAttempt((current) => current + 1);
    },
  };
}
