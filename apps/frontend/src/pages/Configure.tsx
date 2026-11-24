import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ACCOUNT_KEY_PATTERN } from "@stremlist/shared/constants";
import {
  MAX_LISTS,
  connectionProviders,
  listSources,
  sourceKey,
} from "@stremlist/shared/list-merge";
import {
  isProviderId,
  PROVIDERS,
  staticSource,
} from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import {
  DragDropProvider,
  KeyboardSensor,
  PointerSensor,
} from "@dnd-kit/react";
import { PointerActivationConstraints } from "@dnd-kit/dom";
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
import NewTitlesRow from "../components/NewTitlesRow";
import CatalogNameSettings from "../components/CatalogNameSettings";
import PosterSourceSettings from "../components/PosterSourceSettings";
import type { LinkProblem, ResolvedLink } from "../components/LinkPaste";
import ProviderList from "../components/ProviderList";
import ProviderOutageBanner from "../components/ProviderOutageBanner";
import QuickAdd from "../components/QuickAdd";
import WatchTrackingSettings from "../components/WatchTrackingSettings";
import RelativeTime from "../components/RelativeTime";
import SortableListRow from "../components/SortableListRow";
import { SectionHeading, SplitLayout, Wordmark } from "../components/brand";
import { usePendingIndicator } from "../hooks/usePendingIndicator";
import { useNow } from "../hooks/useNow";
import { useSEO } from "../hooks/useSEO";
import { useAccountConfiguration } from "../hooks/useAccountConfiguration";
import type { AddListProblem } from "../hooks/useListEditor";
import { useChecklistHidden } from "../hooks/useChecklistHidden";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { useWatchTracking } from "../hooks/useWatchTracking";
import { ConnectionsContext } from "../hooks/useCatalogPreview";
import { accountEditPolicy } from "../lib/account-config";
import { NEW_ACCOUNT_STORAGE } from "../lib/connections";
import { sourceKeys } from "../lib/list-form";
import { catalogRows } from "../lib/new-titles";
import { attentionTone } from "../lib/list-sync";
import { describeSource, PASTE_LINK_PROMPT } from "../lib/list-sources";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const PENDING_LINK_STORAGE = "stremlist:pending-link";

const catalogSensors = [
  PointerSensor.configure({
    activationConstraints(event, source) {
      if (event.pointerType === "touch") {
        return [new PointerActivationConstraints.Distance({ value: 4 })];
      }
      const defaults = PointerSensor.defaults.activationConstraints;
      return typeof defaults === "function"
        ? defaults(event, source)
        : defaults;
    },
  }),
  KeyboardSensor,
];

type Notice = { type: "success" | "error"; message: string };

function readStorage(key: string) {
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
  } catch {}
}

function connectionNotice(
  connected: string | null,
  error: string | null,
  providerParam: string | null,
) {
  if (connected && isProviderId(connected)) {
    return {
      type: "success",
      message: `${PROVIDERS[connected].label} is connected. You can now add its lists.`,
    } satisfies Notice;
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
  } satisfies Notice;
}

const homeState = z
  .object({ link: z.unknown().optional(), entry: z.unknown().optional() })
  .partial();

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
  const [fromHome] = useState(
    () => homeState.safeParse(location.state).data?.entry === "home",
  );
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
    const next = new URLSearchParams(searchParams);
    for (const key of cleanup) next.delete(key);
    if (rawKey) next.set("account", rawKey);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, rawKey, location.key]);

  const [createdId, setCreatedId] = useState(() =>
    readStorage(NEW_ACCOUNT_STORAGE),
  );
  const revealInstall = useRef(false);
  const rememberCreated = (id: string) => {
    revealInstall.current = true;
    writeStorage(NEW_ACCOUNT_STORAGE, id);
    setCreatedId(id);
  };
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
  const full = lists.length >= MAX_LISTS;
  const ready = status === "ready" && (!rawKey || keyIsValid);
  const justCreated = !!accountId && createdId === accountId;
  const policy = accountEditPolicy(access, config.upgradedTo);
  const watch = useWatchTracking(
    access === "private" ? accountId : null,
    [
      config.stremio.connection?.email ?? "",
      String(!!config.stremio.connection),
      config.stremio.link.kind,
      ...config.connections.map(
        (c) => `${c.provider}:${c.needsRenewalSince ?? ""}`,
      ),
    ].join("|"),
    () => void config.stremio.retry(),
  );
  const rows = lists.map((list) => config.rowModel(list));
  const shownRows = catalogRows(lists, config.newTitles);
  const allGenres = [
    ...new Set(lists.flatMap((list) => list.availableGenres)),
  ].sort();
  const attention = rows.filter((row) => attentionTone(row.sync)).length;
  const leaveBlocker = useLeaveGuard(
    config.dirty && config.connecting === null,
  );

  const installCard = useRef<HTMLDivElement>(null);
  const stremioHeader = useRef<HTMLDivElement>(null);
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

  const { lastAdded } = config;
  useEffect(() => {
    if (!lastAdded) return;
    const frame = requestAnimationFrame(() => {
      const element = listRowElement(lastAdded.localId);
      if (!element || isInView(element)) return;
      toast.success(`Added ${lastAdded.title}`, {
        id: "list-add",
        action: {
          label: "Show",
          onClick: () => showListRow(lastAdded.localId),
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

  const describeAddProblem = (problem: AddListProblem | null) => {
    if (!problem) return null;
    return problem.kind === "duplicate"
      ? ({
          message: "This list is already in your Stremlist.",
          tone: "info",
          showList: () => showListRow(problem.localId),
        } satisfies LinkProblem)
      : ({ message: problem.message } satisfies LinkProblem);
  };

  const notifyAddProblem = (problem: AddListProblem | null) => {
    const notice = describeAddProblem(problem);
    if (!notice) return;
    if (notice.showList) {
      toast(notice.message, {
        id: "list-add",
        action: { label: "Show", onClick: notice.showList },
      });
    } else toast.error(notice.message, { id: "list-add" });
  };

  const addResolved = (link: ResolvedLink) =>
    describeAddProblem(
      config.addList({
        provider: link.provider,
        sourceRef: link.sourceRef,
        catalogTitle:
          link.suggestedTitle ??
          describeSource(link.provider, link.sourceRef).suggestedTitle,
        displayMode: link.defaultDisplayMode ?? undefined,
      }),
    );

  const connectFor = (provider: ProviderId, link?: string) => {
    writeStorage(PENDING_LINK_STORAGE, link ?? null);
    void config.connect(provider);
  };

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
  const providerAccounts = useRef<HTMLDivElement>(null);
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
          <div
            ref={providerAccounts}
            role="group"
            aria-label="Provider accounts"
            tabIndex={-1}
            className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand/70"
          >
            <ProviderList
              access={access}
              detected={detected}
              connections={config.connections}
              providerStatus={config.providerStatus}
              connecting={config.connecting}
              connectLocked={policy.editLock}
              affectedLists={affectedLists}
              onConnect={(provider) =>
                policy.upgradeToConnect
                  ? scrollToUpgrade()
                  : connectFor(provider)
              }
              onDisconnect={(provider) => void config.disconnect(provider)}
            />
          </div>
          {policy.connectHint === "save-first" && (
            <p className="text-xs text-pretty text-white/45">
              When an account connects, Stremlist saves your setup with it and
              gives you a private Addon URL.
            </p>
          )}
          {policy.connectHint === "upgrade" && (
            <p className="text-xs text-pretty text-white/45">
              To connect an account, you need a private Addon URL.{" "}
              <Button
                type="button"
                variant="link-brand"
                size="inline-xs"
                onClick={scrollToUpgrade}
              >
                Upgrade this install
              </Button>
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
                      ? "motion-safe:animate-pulse bg-warning-400"
                      : attention > 0
                        ? "bg-warning-500"
                        : config.lastFetchedAt
                          ? "bg-success-500"
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
                      <span className="font-semibold text-warning-700">
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

        <ProviderOutageBanner providerStatus={config.providerStatus} />

        {ready && accountKey && !policy.editLock && (
          <StremioUpdateNotice
            accountKey={accountKey}
            state={config.reinstall}
            stremio={config.stremio}
            onReinstalled={config.markReinstalled}
          />
        )}

        {(rawKey && !keyIsValid) || status === "notFound" ? (
          <Alert size="card">
            <AlertTitle>We could not find this Stremlist</AlertTitle>
            <AlertDescription>
              Check that you opened the configure page from your Stremio
              install, or paste your Addon URL on the home page. You can also
              build a new Stremlist.
            </AlertDescription>
            <Button size="pill-lg" asChild>
              <Link to="/configure">Build a new Stremlist</Link>
            </Button>
          </Alert>
        ) : status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-black/45">
            <Loader2 className="size-4 animate-spin" />
            Loading your Stremlist
          </p>
        ) : status === "error" ? (
          <Alert variant="destructive" size="card">
            <AlertDescription>
              Could not load your configuration. Please try again.
            </AlertDescription>
            <Button
              type="button"
              variant="plain"
              size="pill"
              onClick={config.retryLoad}
            >
              Try again
            </Button>
          </Alert>
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
              {lists.length === 0 && (
                <div className="rounded-3xl border-2 border-dashed border-black/10 p-6 text-center">
                  <p className="font-bold">No lists yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-pretty text-black/55">
                    {PASTE_LINK_PROMPT} in the Providers panel, or pick one
                    below.
                  </p>
                </div>
              )}
              {shownRows.length > 0 && (
                <DragDropProvider
                  sensors={catalogSensors}
                  onDragEnd={(event) => {
                    if (event.canceled || policy.editLock) return;
                    const { source } = event.operation;
                    if (isSortable(source)) {
                      const { initialIndex, index } = source;
                      if (initialIndex !== index) {
                        config.reorderRows(initialIndex, index);
                      }
                    }
                  }}
                >
                  <ConnectionsContext value={config.connections}>
                    <div className="space-y-3">
                      {shownRows.map((row, index) => {
                        const onMoveUp =
                          !policy.editLock && index > 0
                            ? () => config.reorderRows(index, index - 1)
                            : undefined;
                        const onMoveDown =
                          !policy.editLock && index < shownRows.length - 1
                            ? () => config.reorderRows(index, index + 1)
                            : undefined;
                        if (row.kind === "new-titles") {
                          return (
                            <NewTitlesRow
                              key={row.id}
                              settings={config.newTitles.settings}
                              index={index}
                              justAdded={row.id === lastAdded?.localId}
                              summary={config.newTitlesSummary}
                              genres={allGenres}
                              sources={lists
                                .flatMap(listSources)
                                .map(({ provider, sourceRef }) => ({
                                  provider,
                                  sourceRef,
                                }))
                                .sort((a, b) =>
                                  sourceKey(a).localeCompare(sourceKey(b)),
                                )}
                              previewRevision={config.newTitlesRevision}
                              locked={!!policy.editLock}
                              accountKey={accountId ?? accountKey}
                              rpdbApiKey={config.rpdbApiKey}
                              posterSource={config.posterSource}
                              onFieldChange={config.setNewTitlesField}
                              onRemove={config.removeNewTitles}
                              onMoveUp={onMoveUp}
                              onMoveDown={onMoveDown}
                            />
                          );
                        }
                        const { list } = row;
                        const { sync, missing, connectProvider, saved } =
                          rows[row.listIndex];
                        return (
                          <SortableListRow
                            key={list.localId}
                            list={list}
                            index={index}
                            justAdded={list.localId === lastAdded?.localId}
                            accountKey={accountId ?? accountKey}
                            rpdbApiKey={config.rpdbApiKey}
                            posterSource={config.posterSource}
                            onFieldChange={config.setListField}
                            onRemove={config.removeList}
                            onMoveUp={onMoveUp}
                            onMoveDown={onMoveDown}
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
                {shownRows.length > 1 &&
                  ". Drag the handle, or use Move up and Move down in Settings."}
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
                    catalogTitle: staticSource(provider, source.ref)
                      ? describeSource(provider, source.ref).suggestedTitle
                      : source.label,
                    displayMode: source.defaultDisplayMode,
                  });
                  notifyAddProblem(error);
                }}
                onAddChart={(chartId) => {
                  const error = config.addChartList(chartId);
                  notifyAddProblem(error);
                }}
                newTitles={
                  config.newTitles.enabled
                    ? null
                    : {
                        onAdd: config.addNewTitles,
                        disabled: !!policy.editLock,
                      }
                }
              />
            </section>

            <section className="space-y-3">
              <SectionHeading size="md" title="Options" />
              <div className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
                <PosterSourceSettings
                  value={config.posterSource}
                  onChange={config.setPosterSource}
                  rpdbApiKey={config.rpdbApiKey}
                  onRpdbApiKeyChange={config.setRpdbApiKey}
                />
              </div>

              <div className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
                <CatalogNameSettings
                  value={config.catalogNamePrefix}
                  onChange={config.setCatalogNamePrefix}
                />
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
                key={config.accountId ?? "new"}
                destinations={watch.status?.destinations ?? null}
                consented={watch.status?.consented ?? false}
                stremioLinked={watch.status?.stremioLinked ?? false}
                stremioTrakt={watch.status?.stremioTrakt ?? false}
                loadFailed={watch.failed}
                busy={watch.busy}
                notice={watch.notice}
                locked={policy.watchLock}
                onToggle={watch.toggle}
                onStop={watch.stop}
                onRetryWrites={() => void watch.retryWrites()}
                onRetry={() => void watch.retry()}
                onLinkStremio={() => stremioStep(config.stremio.connect)}
                onManageAccounts={() => {
                  const section = providerAccounts.current;
                  const target =
                    section?.querySelector<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ) ?? section;
                  target?.scrollIntoView({
                    behavior: scrollBehavior(),
                    block: "center",
                  });
                  target?.focus({ preventScroll: true });
                }}
                onInstallAgain={() => stremioStep(config.stremio.installAgain)}
                onUpdateStremio={() => stremioStep(config.stremio.retry)}
              />
            </section>

            {config.validationError && (
              <Alert variant="destructive">{config.validationError}</Alert>
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

function scrollBehavior() {
  const behavior: ScrollBehavior = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches
    ? "auto"
    : "smooth";
  return behavior;
}

function listRowElement(localId: string) {
  return document.querySelector<HTMLElement>(
    `[data-list-row="${CSS.escape(localId)}"]`,
  );
}

function showListRow(localId: string) {
  listRowElement(localId)?.scrollIntoView({
    behavior: scrollBehavior(),
    block: "start",
  });
}

function isInView(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return rect.top >= 0 && rect.top + 48 <= window.innerHeight;
}

function RefreshButton({
  compact,
  refreshing,
  nextRefreshAt,
  onRefresh,
}: {
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
