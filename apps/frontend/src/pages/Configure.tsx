import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ACCOUNT_KEY_PATTERN } from "@stremlist/shared/constants";
import { MAX_LISTS, connectionProviders } from "@stremlist/shared/list-merge";
import {
  isProviderId,
  PROVIDERS,
  staticSource,
} from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import ActionsSettings from "../components/ActionsSettings";
import FloatingSaveButton, {
  SAVE_BUTTON_CLASS,
} from "../components/FloatingSaveButton";
import { AddonUrlCard } from "../components/AccountCards";
import {
  StremioStatus,
  StremioUpdateNotice,
} from "../components/StremioUpdateNotice";
import LeaveDialog from "../components/LeaveDialog";
import LegacyChecklist, { WhatsNewButton } from "../components/LegacyChecklist";
import LinkPaste from "../components/LinkPaste";
import NewTitlesSettings from "../components/NewTitlesSettings";
import type { ResolvedLink } from "../components/LinkPaste";
import ProviderList from "../components/ProviderList";
import QuickAdd from "../components/QuickAdd";
import WatchTrackingSettings from "../components/WatchTrackingSettings";
import RelativeTime from "../components/RelativeTime";
import SortableListRow from "../components/SortableListRow";
import { SectionHeading, SplitLayout, Wordmark } from "../components/brand";
import { usePendingIndicator } from "../hooks/usePendingIndicator";
import { useNow } from "../hooks/useNow";
import { useSEO } from "../hooks/useSEO";
import { useAccountConfiguration } from "../hooks/useAccountConfiguration";
import { useChecklistHidden } from "../hooks/useChecklistHidden";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { useWatchTracking } from "../hooks/useWatchTracking";
import { ConnectionsContext } from "../hooks/useCatalogPreview";
import { accountEditPolicy } from "../lib/account-config";
import { NEW_ACCOUNT_STORAGE } from "../lib/connections";
import { rowTitle, sourceKeys } from "../lib/list-form";
import { attentionTone } from "../lib/list-sync";
import { describeSource, PASTE_LINK_PROMPT } from "../lib/list-sources";
import { cn } from "@/lib/utils";

/** A link that waited for a Connection, added again after the OAuth return. */
const PENDING_LINK_STORAGE = "stremlist:pending-link";

type Notice = { type: "success" | "error"; message: string };

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Private mode: the page still works, only the hand-off is lost.
  }
}

function connectionNotice(
  connected: string | null,
  error: string | null,
  providerParam: string | null,
): Notice | null {
  if (connected && isProviderId(connected)) {
    return {
      type: "success",
      message: `${PROVIDERS[connected].label} is connected. You can now add its lists.`,
    };
  }
  if (error === null) return null;
  const label =
    providerParam && isProviderId(providerParam)
      ? PROVIDERS[providerParam].label
      : "the account";
  const messages = new Map([
    ["denied", `You cancelled the connection to ${label}. Nothing changed.`],
    ["expired", `The connection to ${label} took too long. Please try again.`],
    [
      "unavailable",
      `${label} is temporarily unavailable. Please try again later.`,
    ],
    [
      "invalid_request",
      "The connection could not be completed. Please try again.",
    ],
    [
      "other_browser",
      "This connection was not started in this browser, so nothing was connected. Start it again from your configure page.",
    ],
  ]);
  return {
    type: "error",
    message:
      messages.get(error) ?? `Could not connect ${label}. Please try again.`,
  };
}

/** What Home passes in the navigation state. Other values are ignored. */
const homeState = z.object({ link: z.unknown(), entry: z.unknown() }).partial();

export default function Configure() {
  useSEO({ path: "/configure" });

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const rawKey = searchParams.get("account") ?? searchParams.get("userId");
  const keyIsValid = !!rawKey && ACCOUNT_KEY_PATTERN.test(rawKey);
  const accountKey = keyIsValid ? rawKey : null;

  const [pendingLink, setPendingLink] = useState<string | null>(() => {
    const homeLink = homeState.safeParse(location.state).data?.link;
    if (typeof homeLink === "string") return homeLink;
    const stored = readStorage(PENDING_LINK_STORAGE);
    writeStorage(PENDING_LINK_STORAGE, null);
    return searchParams.get("connected") ? stored : null;
  });
  /** Home found this v1 install for the user ("Open my Stremlist"). */
  const [fromHome] = useState(
    () => homeState.safeParse(location.state).data?.entry === "home",
  );
  // The link from Home is consumed once; drop it so a reload does not add
  // it again.
  useEffect(() => {
    if (location.state) {
      void navigate(
        { pathname: location.pathname, search: location.search },
        { replace: true, state: null },
      );
    }
  }, [location, navigate]);
  useEffect(() => {
    const cleanup = ["connected", "connection_error", "provider", "userId"];
    if (!cleanup.some((key) => searchParams.has(key))) return;
    const notice = connectionNotice(
      searchParams.get("connected"),
      searchParams.get("connection_error"),
      searchParams.get("provider"),
    );
    if (notice) {
      toast[notice.type](notice.message, { id: `connection-${location.key}` });
    }
    // Consume the OAuth result so reloading does not show the toast again.
    const next = new URLSearchParams(searchParams);
    for (const key of cleanup) next.delete(key);
    if (rawKey) next.set("account", rawKey);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, rawKey, location.key]);

  const [createdId, setCreatedId] = useState(() =>
    readStorage(NEW_ACCOUNT_STORAGE),
  );
  /** Set when an Account is created here, until its install step is shown. */
  const revealInstall = useRef(false);
  /** Show the install step of an Account created in this tab. */
  const rememberCreated = (id: string) => {
    revealInstall.current = true;
    writeStorage(NEW_ACCOUNT_STORAGE, id);
    setCreatedId(id);
  };
  /** Open an Account created by the first save; it replaces the entry. */
  const openCreated = (id: string) => {
    rememberCreated(id);
    void navigate(`/configure?account=${encodeURIComponent(id)}`, {
      replace: true,
    });
  };

  const config = useAccountConfiguration(accountKey, {
    onAccountCreated: openCreated,
  });
  const { lists, access, accountId, status } = config;
  const [detected, setDetected] = useState<ProviderId | null>(null);
  const [showRpdbApiKey, setShowRpdbApiKey] = useState(false);
  const full = lists.length >= MAX_LISTS;
  const ready = status === "ready" && (!rawKey || keyIsValid);
  const justCreated = !!accountId && createdId === accountId;
  const policy = accountEditPolicy(access, config.upgradedTo);
  // A Connection or the Stremio link changes what Watch tracking can use.
  const watch = useWatchTracking(
    access === "private" ? accountId : null,
    [
      config.stremio.connection?.email ?? "",
      String(!!config.stremio.connection),
      // A link to the same account again changes neither of these.
      config.stremio.link.kind,
      ...config.connections.map(
        (c) => `${c.provider}:${c.needsRenewalSince ?? ""}`,
      ),
    ].join("|"),
    () => void config.stremio.retry(),
  );
  const rows = lists.map((list) => config.rowModel(list));
  const attention = rows.filter((row) => attentionTone(row.sync)).length;
  // Leaving for a Provider keeps the edits (a draft), so Connect is not held.
  const leaveBlocker = useLeaveGuard(
    config.dirty && config.connecting === null,
  );

  // After the first save, bring the install step into view: on a phone it
  // is far above the Save button that the user pressed.
  const installCard = useRef<HTMLDivElement>(null);
  // The Stremio card is in the page header: below the Providers panel on a
  // phone, so "the top" of the document is not where it shows.
  const stremioHeader = useRef<HTMLDivElement>(null);
  /** Clears the card's notice, starts a Stremio step, and shows its card. */
  const stremioStep = (step: () => Promise<unknown>) => {
    watch.clearNotice();
    void step();
    stremioHeader.current?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "start",
    });
  };
  useEffect(() => {
    const card = installCard.current;
    if (!justCreated || !revealInstall.current || !card) return;
    revealInstall.current = false;
    card.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    card.focus({ preventScroll: true });
  }, [justCreated]);

  // A new List is the first row. When that row is out of view (on a phone,
  // the lists are below the Providers panel; from Quick add, they are above
  // it), a toast says so and can show the row.
  const { lastAdded } = config;
  useEffect(() => {
    if (!lastAdded) return;
    const frame = requestAnimationFrame(() => {
      const element = listRowElement(lastAdded.localId);
      if (!element || isInView(element)) return;
      toast.success(`Added ${rowTitle(lastAdded)}`, {
        id: "list-add",
        action: {
          label: "Show",
          onClick: () =>
            listRowElement(lastAdded.localId)?.scrollIntoView({
              behavior: scrollBehavior(),
              // The new row opens its preview and can be taller than the
              // screen: show its top.
              block: "start",
            }),
        },
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [lastAdded]);

  const affectedLists: Partial<Record<ProviderId, number>> = {};
  for (const list of lists) {
    for (const provider of connectionProviders(list)) {
      affectedLists[provider] = (affectedLists[provider] ?? 0) + 1;
    }
  }

  const addResolved = (link: ResolvedLink): string | null =>
    config.addList({
      provider: link.provider,
      sourceRef: link.sourceRef,
      catalogTitle:
        link.suggestedTitle ??
        describeSource(link.provider, link.sourceRef).suggestedTitle,
      displayMode: link.defaultDisplayMode ?? undefined,
    });

  const connectFor = (provider: ProviderId, link?: string) => {
    writeStorage(PENDING_LINK_STORAGE, link ?? null);
    void config.connect(provider);
  };

  // The header Save button; the floating Save button shows once it scrolls
  // away.
  const [headerSave, setHeaderSave] = useState<HTMLButtonElement | null>(null);
  const [headerSaveVisible, setHeaderSaveVisible] = useState(true);
  useEffect(() => {
    if (!headerSave) return;
    const observer = new IntersectionObserver(([entry]) =>
      setHeaderSaveVisible(entry.isIntersecting),
    );
    observer.observe(headerSave);
    return () => observer.disconnect();
  }, [headerSave]);
  const canSave = !policy.editLock && lists.length > 0;
  const showSaveBar = ready && canSave && !!headerSave && !headerSaveVisible;
  // `handleSave` ignores clicks while a save runs, so the button stays
  // enabled: dimming it for a fast save would flash. With nothing to save
  // (no edits since the last save or load), it is off. A new setup, a
  // restored draft and edits made during a save all differ from the saved
  // form, so they keep it on.
  const nothingToSave = !config.saveNeeded;
  const saveDisabled = !canSave || !!config.validationError || nothingToSave;
  const saveHint = canSave && nothingToSave ? "No changes to save" : undefined;
  const showSaving = usePendingIndicator(config.saving);
  const saveLabel = (
    <>
      {showSaving && <Loader2 className="size-4 animate-spin" />}
      {showSaving ? "Saving" : "Save"}
    </>
  );

  // The Stremlist 2.0 card of a v1 install, with the private URL upgrade.
  const legacyKey = access === "legacy" ? accountKey : null;
  const legacy = !!legacyKey;
  const [checklistHidden, setChecklistHidden] = useChecklistHidden(legacyKey);
  const [upgradeRequest, setUpgradeRequest] = useState(0);
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false);
  const scrollToUpgrade = () => {
    setChecklistHidden(false);
    setUpgradeRequest((count) => count + 1);
  };
  const pasteInput = useRef<HTMLInputElement>(null);
  const focusPaste = () => {
    const input = pasteInput.current;
    if (!input) return;
    input.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    input.focus({ preventScroll: true });
  };

  const panel = (
    <div className="space-y-8">
      <Wordmark />
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Providers</h1>
        <p className="mt-1 text-white/60">
          Paste a link, or connect an account.
        </p>
      </div>

      {ready && (
        <>
          <LinkPaste
            accountKey={accountKey}
            access={access}
            disabled={full || !!policy.editLock}
            disabledReason={
              policy.editLock ??
              `You have ${MAX_LISTS} lists, the maximum. Remove one to add another.`
            }
            initialValue={pendingLink ?? undefined}
            onInitialValueUsed={() => setPendingLink(null)}
            onDetect={setDetected}
            onResolved={addResolved}
            onConnect={connectFor}
            onUpgrade={scrollToUpgrade}
            inputRef={pasteInput}
          />
          <ProviderList
            access={access}
            detected={detected}
            connections={config.connections}
            providerStatus={config.providerStatus}
            connecting={config.connecting}
            connectLocked={policy.editLock}
            affectedLists={affectedLists}
            onConnect={(provider) =>
              policy.upgradeToConnect ? scrollToUpgrade() : connectFor(provider)
            }
            onDisconnect={(provider) => void config.disconnect(provider)}
          />
          {policy.connectHint === "save-first" && (
            <p className="text-xs text-pretty text-white/45">
              When an account connects, Stremlist saves your setup with it and
              gives you a private Addon URL.
            </p>
          )}
          {policy.connectHint === "upgrade" && (
            <p className="text-xs text-pretty text-white/45">
              To connect an account, you need a private Addon URL.{" "}
              <button
                type="button"
                onClick={scrollToUpgrade}
                className="font-semibold text-brand underline-offset-2 hover:underline"
              >
                Upgrade this install
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );

  return (
    <SplitLayout panel={panel}>
      <div className="mx-auto max-w-3xl space-y-6 p-5 pb-24 sm:p-8 lg:p-12">
        <div ref={stremioHeader} className="scroll-mt-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-3xl font-bold tracking-tight">Your lists</h2>
              <p className="text-black/55">
                Each list becomes a catalog row in Stremio, in this order.
              </p>
              {access === "legacy" && accountKey && (
                <p className="mt-1 text-xs text-black/45">
                  Installed with IMDb user ID{" "}
                  <span className="font-mono text-black/70">{accountKey}</span>
                </p>
              )}
            </div>
            {ready && !policy.editLock && (
              <button
                ref={setHeaderSave}
                type="button"
                onClick={() => void config.handleSave()}
                disabled={saveDisabled}
                title={saveHint}
                className={cn(
                  SAVE_BUTTON_CLASS,
                  "h-10 rounded-full px-5 text-sm transition-[background-color,opacity,scale] duration-150 ease-out",
                )}
              >
                {saveLabel}
              </button>
            )}
          </div>
          {accountKey && ready && (
            // On a v1 install, one line as tall as its buttons, so "What's
            // new" can come and go without moving the page. Phones then show
            // the time and the refresh icon only.
            <div
              className={cn(
                "flex min-h-9 items-center gap-3",
                !legacy && "flex-wrap",
              )}
            >
              <p className="flex min-w-0 items-center gap-2 text-sm text-black/55">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    config.refreshing
                      ? "motion-safe:animate-pulse bg-amber-400"
                      : attention > 0
                        ? "bg-amber-500"
                        : config.lastFetchedAt
                          ? "bg-emerald-500"
                          : "bg-black/20",
                  )}
                  aria-hidden="true"
                />
                <span className={cn("tabular-nums", legacy && "truncate")}>
                  <span className={cn(legacy && "sr-only sm:not-sr-only")}>
                    Refreshed{" "}
                  </span>
                  <span className="font-semibold text-ink">
                    <RelativeTime iso={config.lastFetchedAt} />
                  </span>
                  {attention > 0 && (
                    <>
                      {" · "}
                      <span className="font-semibold text-amber-700">
                        {attention === 1
                          ? "1 list needs attention"
                          : `${attention} lists need attention`}
                      </span>
                    </>
                  )}
                </span>
              </p>
              <RefreshButton
                compact={legacy}
                refreshing={config.refreshing}
                nextRefreshAt={config.nextRefreshAt}
                onRefresh={() => void config.handleRefresh()}
              />
              {legacy && checklistHidden && (
                <WhatsNewButton onClick={() => setChecklistHidden(false)} />
              )}
              {!policy.editLock && <StremioStatus stremio={config.stremio} />}
            </div>
          )}
        </div>

        {ready && accountKey && !policy.editLock && (
          <StremioUpdateNotice
            accountKey={accountKey}
            state={config.reinstall}
            stremio={config.stremio}
            onReinstalled={config.markReinstalled}
          />
        )}

        {(rawKey && !keyIsValid) || status === "notFound" ? (
          <div
            role="alert"
            className="space-y-3 rounded-3xl bg-white p-6 ring-1 ring-black/5"
          >
            <p className="font-bold">We could not find this Stremlist</p>
            <p className="text-sm text-black/60">
              Check that you opened the configure page from your Stremio
              install, or paste your Addon URL on the home page. You can also
              build a new Stremlist.
            </p>
            <Link
              to="/configure"
              className="inline-flex h-10 items-center rounded-full bg-brand px-5 text-sm font-bold text-black hover:bg-brand-dark"
            >
              Build a new Stremlist
            </Link>
          </div>
        ) : status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-black/45">
            <Loader2 className="size-4 animate-spin" />
            Loading your Stremlist
          </p>
        ) : status === "error" ? (
          <div
            role="alert"
            className="space-y-3 rounded-3xl bg-red-50 p-5 text-sm text-red-700 ring-1 ring-red-200"
          >
            <p>Could not load your configuration. Please try again.</p>
            <button
              type="button"
              onClick={config.retryLoad}
              className="rounded-full bg-white px-4 py-2 font-semibold ring-1 ring-red-200 hover:bg-red-100"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {justCreated && accountId && (
              <div
                ref={installCard}
                tabIndex={-1}
                className="scroll-mt-5 rounded-3xl outline-none"
              >
                <AddonUrlCard accountKey={accountId} variant="created" />
              </div>
            )}

            {legacyKey && !checklistHidden && (
              <LegacyChecklist
                legacyKey={legacyKey}
                fromHome={fromHome}
                imdbLists={
                  lists.filter((list) => list.provider === "imdb").length
                }
                otherProviderAdded={lists.some((list) =>
                  [list, ...list.mergedSources].some(
                    (source) => source.provider !== "imdb",
                  ),
                )}
                unsaved={config.dirty}
                locked={!!policy.editLock}
                upgradedTo={config.upgradedTo}
                upgradeConfirmed={upgradeConfirmed}
                onUpgrade={config.upgrade}
                onConfirmUpgrade={() => setUpgradeConfirmed(true)}
                onOpenNew={rememberCreated}
                onPasteLink={focusPaste}
                onHide={() => {
                  setChecklistHidden(true);
                  setUpgradeRequest(0);
                }}
                upgradeRequest={upgradeRequest}
              />
            )}

            <section className="space-y-3">
              {lists.length === 0 ? (
                <div className="rounded-3xl border-2 border-dashed border-black/10 p-6 text-center">
                  <p className="font-bold">No lists yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-pretty text-black/55">
                    {PASTE_LINK_PROMPT} in the Providers panel, or pick one
                    below.
                  </p>
                </div>
              ) : (
                <DragDropProvider
                  onDragEnd={(event) => {
                    if (event.canceled) return;
                    const { source } = event.operation;
                    if (isSortable(source)) {
                      const { initialIndex, index } = source;
                      if (initialIndex !== index) {
                        config.reorderLists(initialIndex, index);
                      }
                    }
                  }}
                >
                  <ConnectionsContext value={config.connections}>
                    <div className="space-y-3">
                      {lists.map((list, index) => {
                        const { sync, missing, connectProvider, saved } =
                          rows[index];
                        return (
                          <SortableListRow
                            key={list.localId}
                            list={list}
                            index={index}
                            justAdded={list.localId === lastAdded?.localId}
                            accountKey={accountId ?? accountKey}
                            rpdbApiKey={config.rpdbApiKey}
                            onFieldChange={config.setListField}
                            onRemove={config.removeList}
                            missingProviders={missing}
                            sync={sync}
                            saved={saved}
                            onConnect={
                              config.providerStatus[connectProvider].connectable
                                ? () => connectFor(connectProvider)
                                : undefined
                            }
                            merge={
                              policy.editLock
                                ? undefined
                                : {
                                    others: lists.filter(
                                      (other) => other !== list,
                                    ),
                                    canSplit: !full,
                                    onMerge: config.mergeLists,
                                    onRemoveSource: config.removeSource,
                                    onSplitSource: config.splitSource,
                                  }
                            }
                          />
                        );
                      })}
                    </div>
                  </ConnectionsContext>
                </DragDropProvider>
              )}
              <p className="px-1 text-xs text-black/45 tabular-nums">
                {lists.length} of {MAX_LISTS} lists
                {lists.length > 1 && ". Drag the handle to reorder."}
              </p>
            </section>

            <section className="space-y-3">
              <SectionHeading size="md" title="Quick add" />
              <QuickAdd
                connections={config.connections}
                connectionSources={config.connectionSources}
                providerStatus={config.providerStatus}
                usedKeys={sourceKeys(lists)}
                full={full || !!policy.editLock}
                onAdd={(provider, source) => {
                  const error = config.addList({
                    provider,
                    sourceRef: source.ref,
                    // Static sources get "Trakt Watchlist"; the account's
                    // own lists keep their real name.
                    catalogTitle: staticSource(provider, source.ref)
                      ? describeSource(provider, source.ref).suggestedTitle
                      : source.label,
                    displayMode: source.defaultDisplayMode,
                  });
                  if (error) toast.error(error, { id: "list-add" });
                }}
                onAddChart={(chartId) => {
                  // The chart menu is off only when the List limit is
                  // reached; the Source list limit is checked here.
                  const error = config.addChartList(chartId);
                  if (error) toast.error(error, { id: "list-add" });
                }}
              />
            </section>

            <section className="space-y-3">
              <SectionHeading size="md" title="Options" />
              <div className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
                <label htmlFor="rpdb-api-key" className="block font-bold">
                  RPDB API key{" "}
                  <span className="font-normal text-black/45">(optional)</span>
                </label>
                <p className="mt-0.5 mb-3 text-sm text-black/55">
                  Shows{" "}
                  <a
                    href="https://ratingposterdb.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-stremlist hover:underline"
                  >
                    Rating Poster Database
                  </a>{" "}
                  posters, with ratings on the cover art.
                </p>
                <div className="flex items-center gap-1 rounded-2xl bg-black/5 p-1">
                  <input
                    id="rpdb-api-key"
                    type={showRpdbApiKey ? "text" : "password"}
                    value={config.rpdbApiKey}
                    onChange={(e) => config.setRpdbApiKey(e.target.value)}
                    placeholder="Paste your RPDB API key"
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRpdbApiKey((current) => !current)}
                    aria-label={
                      showRpdbApiKey ? "Hide RPDB API key" : "Show RPDB API key"
                    }
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl text-black/50 transition-colors hover:bg-white hover:text-ink"
                  >
                    {showRpdbApiKey ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </div>

              <ActionsSettings
                enabled={config.actionsEnabled}
                onEnabledChange={config.setActionsEnabled}
                order={config.actionOrder}
                selected={config.actionSelected}
                onToggle={config.toggleActionProvider}
                onMove={config.moveActionProvider}
                locked={policy.actionsLock}
              />

              <WatchTrackingSettings
                destinations={watch.status?.destinations ?? null}
                stremioLinked={watch.status?.stremioLinked ?? false}
                stremioTrakt={watch.status?.stremioTrakt ?? false}
                loadFailed={watch.failed}
                busy={watch.busy}
                notice={watch.notice}
                locked={policy.watchLock}
                onToggle={(provider, enabled) =>
                  void watch.toggle(provider, enabled)
                }
                onRetry={() => void watch.retry()}
                onLinkStremio={() => stremioStep(config.stremio.connect)}
                onInstallAgain={() => stremioStep(config.stremio.installAgain)}
                onUpdateStremio={() => stremioStep(config.stremio.retry)}
              />

              <NewTitlesSettings
                enabled={config.newTitlesEnabled}
                onEnabledChange={config.setNewTitlesEnabled}
                summary={config.newTitlesSummary}
                locked={policy.editLock}
              />
            </section>

            {config.validationError && (
              <p
                role="alert"
                className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200"
              >
                {config.validationError}
              </p>
            )}

            {accountKey && !justCreated && !policy.editLock && (
              <AddonUrlCard
                accountKey={accountKey}
                variant="install"
                reinstallHint={config.reinstall === "required"}
                onUse={
                  config.reinstall === "required"
                    ? undefined
                    : config.markReinstalled
                }
              />
            )}

            <FloatingSaveButton
              show={showSaveBar}
              disabled={saveDisabled}
              hint={saveHint}
              saving={config.saving}
              onSave={() => void config.handleSave()}
            >
              {saveLabel}
            </FloatingSaveButton>
          </>
        )}
      </div>
      <LeaveDialog blocker={leaveBlocker} />
    </SplitLayout>
  );
}

/** Smooth scrolling, unless the user prefers reduced motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function listRowElement(localId: string): HTMLElement | null {
  return document.querySelector(`[data-list-row="${CSS.escape(localId)}"]`);
}

/** Whether the top of `element` shows in the viewport. */
function isInView(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.top >= 0 && rect.top + 48 <= window.innerHeight;
}

/** "Refresh now", with a live countdown while it waits for the cooldown. */
function RefreshButton({
  compact,
  refreshing,
  nextRefreshAt,
  onRefresh,
}: {
  /** Below `sm`, show the icon only. */
  compact: boolean;
  refreshing: boolean;
  nextRefreshAt: number;
  onRefresh: () => void;
}) {
  const cooldownRemaining = Math.max(
    0,
    Math.ceil((nextRefreshAt - useNow()) / 1000),
  );
  const onCooldown = cooldownRemaining > 0;
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing || onCooldown}
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold whitespace-nowrap tabular-nums ring-1 ring-black/10 transition-colors hover:bg-cloud disabled:opacity-50",
        compact ? "w-9 sm:w-auto sm:px-4" : "px-4",
      )}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn("size-4", refreshing && "animate-spin")}
      />
      <span className={cn(compact && "sr-only sm:not-sr-only")}>
        {refreshing
          ? "Refreshing"
          : onCooldown
            ? `Refresh in ${cooldownRemaining}s`
            : "Refresh now"}
      </span>
    </button>
  );
}
