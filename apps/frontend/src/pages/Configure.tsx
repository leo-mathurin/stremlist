import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
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
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import ActionsSettings from "../components/ActionsSettings";
import {
  AddonUrlCard,
  LegacyUpgradeCard,
  ReinstallNotice,
} from "../components/AccountCards";
import LinkPaste from "../components/LinkPaste";
import NewTitlesSettings from "../components/NewTitlesSettings";
import type { ResolvedLink } from "../components/LinkPaste";
import ProviderList from "../components/ProviderList";
import QuickAdd from "../components/QuickAdd";
import SortableListRow from "../components/SortableListRow";
import { SectionHeading, SplitLayout, Wordmark } from "../components/brand";
import { usePendingIndicator } from "../hooks/usePendingIndicator";
import { useSEO } from "../hooks/useSEO";
import { useAccountConfiguration } from "../hooks/useAccountConfiguration";
import { ConnectionsContext } from "../hooks/connections-context";
import { sourceKeys } from "../lib/list-form";
import { attentionTone } from "../lib/list-sync";
import { describeSource, PASTE_LINK_PROMPT } from "../lib/list-sources";
import { cn, formatRelativeTime } from "@/lib/utils";

/** The Account created in this tab, so its Addon URL warning stays visible. */
const NEW_ACCOUNT_STORAGE = "stremlist:new-account";
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
  const provider =
    providerParam && isProviderId(providerParam) ? providerParam : null;
  const label = provider ? PROVIDERS[provider].label : "the account";
  if (connected && isProviderId(connected)) {
    return {
      type: "success",
      message: `${PROVIDERS[connected].label} is connected. You can now add its lists.`,
    };
  }
  switch (error) {
    case null:
      return null;
    case "denied":
      return {
        type: "error",
        message: `You cancelled the connection to ${label}. Nothing changed.`,
      };
    case "expired":
      return {
        type: "error",
        message: `The connection to ${label} took too long. Please try again.`,
      };
    case "invalid_request":
      return {
        type: "error",
        message: "The connection could not be completed. Please try again.",
      };
    default:
      return {
        type: "error",
        message: `Could not connect ${label}. Please try again.`,
      };
  }
}

export default function Configure() {
  useSEO({
    title: "Configure - Stremlist",
    description:
      "Choose the watchlists and lists that Stremlist shows in Stremio, from IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique.",
    robots: "noindex, nofollow",
  });

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const rawKey = searchParams.get("account") ?? searchParams.get("userId");
  const keyIsValid = !!rawKey && ACCOUNT_KEY_PATTERN.test(rawKey);
  const accountKey = keyIsValid ? rawKey : null;

  const [pendingLink, setPendingLink] = useState<string | null>(() => {
    const homeLink = (location.state as { link?: unknown } | null)?.link;
    if (typeof homeLink === "string") return homeLink;
    const stored = readStorage(PENDING_LINK_STORAGE);
    writeStorage(PENDING_LINK_STORAGE, null);
    return searchParams.get("connected") ? stored : null;
  });
  // The link from Home is consumed once; drop it so a reload does not add
  // it again.
  useEffect(() => {
    if (location.state) {
      navigate(
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
  const onAccountCreated = useCallback(
    (id: string) => {
      writeStorage(NEW_ACCOUNT_STORAGE, id);
      setCreatedId(id);
      navigate(`/configure?account=${encodeURIComponent(id)}`, {
        replace: true,
      });
    },
    [navigate],
  );

  const config = useAccountConfiguration(accountKey, { onAccountCreated });
  const { lists, access, accountId, status } = config;
  const [detected, setDetected] = useState<ProviderId | null>(null);
  const full = lists.length >= MAX_LISTS;
  const ready = status === "ready" && (!rawKey || keyIsValid);
  const justCreated = !!accountId && createdId === accountId;
  // A Legacy alias install that already got a private copy: its changes are
  // refused (409), so the page only offers to make a new private URL.
  const moved = access === "legacy" && !!config.movedAt;
  const MOVED_HINT =
    "This install has a private URL now. Make changes from the configure page of your new install.";
  const rows = lists.map((list) => config.rowModel(list));
  const attention = rows.filter((row) => attentionTone(row.sync)).length;
  const affectedLists: Partial<Record<ProviderId, number>> = {};
  for (const list of lists) {
    for (const provider of connectionProviders(list)) {
      affectedLists[provider] = (affectedLists[provider] ?? 0) + 1;
    }
  }

  const addResolved = (link: ResolvedLink): string | null => {
    const description = describeSource(link.provider, link.sourceRef);
    return config.addList({
      provider: link.provider,
      sourceRef: link.sourceRef,
      catalogTitle: link.suggestedTitle ?? description.suggestedTitle,
      displayMode: link.defaultDisplayMode ?? undefined,
    });
  };

  const connectFor = (provider: ProviderId, link?: string) => {
    writeStorage(PENDING_LINK_STORAGE, link ?? null);
    void config.connect(provider);
  };

  // The header Save button; the floating Save button shows once it scrolls
  // away, and spans the column once it rests at the end of the page.
  const [headerSave, setHeaderSave] = useState<HTMLButtonElement | null>(null);
  const [headerSaveVisible, setHeaderSaveVisible] = useState(true);
  const [floatingSave, setFloatingSave] = useState<HTMLDivElement | null>(null);
  const [floatingDocked, setFloatingDocked] = useState(false);
  // Width of the floating label, so the clip shows a pill around it while
  // the button floats.
  const [floatingLabel, setFloatingLabel] = useState<HTMLSpanElement | null>(
    null,
  );
  const [floatingLabelWidth, setFloatingLabelWidth] = useState(0);
  useEffect(() => {
    if (!headerSave) return;
    const observer = new IntersectionObserver(([entry]) =>
      setHeaderSaveVisible(entry.isIntersecting),
    );
    observer.observe(headerSave);
    return () => observer.disconnect();
  }, [headerSave]);
  useEffect(() => {
    if (!floatingSave) return;
    // While stuck, the button sits 20px (bottom-5) above the viewport edge,
    // so it is never fully inside a root shrunk by 22px. Once it rests in
    // place at the end of the page, it is.
    const observer = new IntersectionObserver(
      ([entry]) => setFloatingDocked(entry.intersectionRatio === 1),
      { rootMargin: "0px 0px -22px 0px", threshold: 1 },
    );
    observer.observe(floatingSave);
    return () => observer.disconnect();
  }, [floatingSave]);
  useEffect(() => {
    if (!floatingLabel) return;
    const observer = new ResizeObserver(([entry]) =>
      setFloatingLabelWidth(entry.borderBoxSize[0].inlineSize),
    );
    observer.observe(floatingLabel);
    return () => observer.disconnect();
  }, [floatingLabel]);
  const canSave = !moved && lists.length > 0;
  const showSaveBar = ready && canSave && !!headerSave && !headerSaveVisible;
  // `handleSave` ignores clicks while a save runs, so the button stays
  // enabled: dimming it for a fast save would flash.
  const saveDisabled = !canSave || !!config.validationError;
  const showSaving = usePendingIndicator(config.saving);
  const saveClassName =
    "inline-flex shrink-0 items-center justify-center gap-2 bg-brand font-bold text-black hover:bg-brand-dark active:scale-[0.97] disabled:opacity-40 motion-reduce:active:scale-100";
  const saveLabel = (
    <>
      {showSaving && <Loader2 className="size-4 animate-spin" />}
      {showSaving ? (
        "Saving"
      ) : access === "new" ? (
        <>
          Save<span className="hidden sm:inline"> and get my Addon URL</span>
        </>
      ) : (
        "Save"
      )}
    </>
  );

  const scrollToUpgrade = () =>
    document
      .getElementById("upgrade")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });

  const panel = (
    <div className="space-y-8">
      <Wordmark />
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Providers</h1>
        <p className="mt-1 text-white/60">
          Paste a link, or connect an account.
        </p>
        {access === "legacy" && accountKey && (
          <p className="mt-2 text-xs text-white/45">
            IMDb install{" "}
            <span className="font-mono text-white/70">{accountKey}</span>
          </p>
        )}
      </div>

      {ready && (
        <>
          <LinkPaste
            accountKey={accountKey}
            access={access}
            disabled={full || moved}
            disabledReason={
              moved
                ? MOVED_HINT
                : `You have ${MAX_LISTS} lists, the maximum. Remove one to add another.`
            }
            initialValue={pendingLink ?? undefined}
            onInitialValueUsed={() => setPendingLink(null)}
            onDetect={setDetected}
            onResolved={addResolved}
            onConnect={connectFor}
            onUpgrade={scrollToUpgrade}
          />
          <ProviderList
            access={access}
            detected={detected}
            connections={config.connections}
            providerStatus={config.providerStatus}
            connecting={config.connecting}
            connectLocked={moved ? MOVED_HINT : undefined}
            affectedLists={affectedLists}
            onConnect={(provider) =>
              access === "legacy" ? scrollToUpgrade() : connectFor(provider)
            }
            onDisconnect={config.disconnect}
          />
          {access === "new" && (
            <p className="text-xs text-pretty text-white/45">
              Connecting an account saves your setup first, because a Connection
              belongs to your private Addon URL.
            </p>
          )}
          {access === "legacy" && !moved && (
            <p className="text-xs text-pretty text-white/45">
              Connections need a private Addon URL.{" "}
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
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-3xl font-bold tracking-tight">Your Lists</h2>
              <p className="text-black/55">
                Each List becomes a catalog row in Stremio, in this order.
              </p>
            </div>
            {ready && !moved && (
              <button
                ref={setHeaderSave}
                type="button"
                onClick={config.handleSave}
                disabled={saveDisabled}
                className={cn(
                  saveClassName,
                  "h-10 rounded-full px-5 text-sm transition-[background-color,opacity,scale] duration-150 ease-out",
                )}
              >
                {saveLabel}
              </button>
            )}
          </div>
          {accountKey && ready && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex items-center gap-2 text-sm text-black/55">
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
                <span className="tabular-nums">
                  Refreshed{" "}
                  <span className="font-semibold text-ink">
                    {formatRelativeTime(config.lastFetchedAt)}
                  </span>
                  {attention > 0 && (
                    <>
                      {" · "}
                      <span className="font-semibold text-amber-700">
                        {attention === 1
                          ? "1 List needs attention"
                          : `${attention} Lists need attention`}
                      </span>
                    </>
                  )}
                </span>
              </p>
              <button
                type="button"
                onClick={config.handleRefresh}
                disabled={config.refreshing || config.onCooldown}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold tabular-nums ring-1 ring-black/10 transition-colors hover:bg-cloud disabled:opacity-50"
              >
                <RefreshCw
                  className={cn("size-4", config.refreshing && "animate-spin")}
                />
                {config.refreshing
                  ? "Refreshing"
                  : config.onCooldown
                    ? `Refresh in ${config.cooldownRemaining}s`
                    : "Refresh now"}
              </button>
            </div>
          )}
        </div>

        {ready && accountKey && !moved && config.reinstall !== "none" && (
          <ReinstallNotice
            accountKey={accountKey}
            state={config.reinstall}
            onReinstalled={config.markReinstalled}
          />
        )}

        {rawKey && !keyIsValid ? (
          <NotFoundCard />
        ) : status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-black/45">
            <Loader2 className="size-4 animate-spin" />
            Loading your Stremlist
          </p>
        ) : status === "notFound" ? (
          <NotFoundCard />
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
              <AddonUrlCard accountKey={accountId} variant="created" />
            )}

            {access === "legacy" && (
              <LegacyUpgradeCard
                movedAt={config.movedAt}
                onUpgrade={config.upgrade}
                onOpen={(id) => {
                  writeStorage(NEW_ACCOUNT_STORAGE, id);
                  setCreatedId(id);
                  navigate(`/configure?account=${encodeURIComponent(id)}`);
                }}
              />
            )}

            <section className="space-y-3">
              {lists.length === 0 ? (
                <div className="rounded-3xl border-2 border-dashed border-black/10 p-6 text-center">
                  <p className="font-bold">No Lists yet</p>
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
                            accountKey={accountId ?? accountKey}
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
                              moved
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
                full={full || moved}
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
                    type={config.showRpdbApiKey ? "text" : "password"}
                    value={config.rpdbApiKey}
                    onChange={(e) => config.setRpdbApiKey(e.target.value)}
                    placeholder="Paste your RPDB API key"
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      config.setShowRpdbApiKey((current) => !current)
                    }
                    aria-label={
                      config.showRpdbApiKey
                        ? "Hide RPDB API key"
                        : "Show RPDB API key"
                    }
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl text-black/50 transition-colors hover:bg-white hover:text-ink"
                  >
                    {config.showRpdbApiKey ? (
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
                locked={
                  moved
                    ? MOVED_HINT
                    : access === "legacy"
                      ? "Actions need a private Addon URL. Upgrade this install first."
                      : access === "new"
                        ? "Save your setup and connect Trakt, Simkl or MDBList to use Actions."
                        : undefined
                }
              />

              <NewTitlesSettings
                enabled={config.newTitlesEnabled}
                onEnabledChange={config.setNewTitlesEnabled}
                summary={config.newTitlesSummary}
                locked={moved ? MOVED_HINT : undefined}
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

            {accountKey && !justCreated && !moved && (
              <AddonUrlCard
                accountKey={accountKey}
                variant="install"
                reinstallHint={config.reinstall === "required"}
                onUse={config.markReinstalled}
              />
            )}

            <div
              ref={setFloatingSave}
              inert={!showSaveBar}
              className={cn(
                "pointer-events-none sticky bottom-5 z-20 flex justify-end transition-[opacity,translate] ease-out-quint motion-reduce:translate-y-0",
                showSaveBar
                  ? "duration-200"
                  : "translate-y-4 opacity-0 duration-150",
              )}
            >
              <button
                type="button"
                onClick={config.handleSave}
                disabled={saveDisabled}
                aria-busy={config.saving}
                style={
                  {
                    "--pill": `${floatingLabelWidth + 64}px`,
                  } as CSSProperties
                }
                className={cn(
                  saveClassName,
                  // Always full width; while floating, the clip shows only a
                  // pill at the right. At the end of the page the clip opens
                  // and the label slides to the center.
                  "@container pointer-events-auto h-14 w-full text-base [transition:clip-path_250ms_var(--ease-in-out-quart),background-color_150ms_ease-out,opacity_150ms_ease-out,scale_150ms_ease-out] motion-reduce:[transition:background-color_150ms_ease-out,opacity_150ms_ease-out]",
                  floatingDocked
                    ? "[clip-path:inset(0_round_9999px)]"
                    : "origin-right [clip-path:inset(0_0_0_calc(100%-var(--pill))_round_9999px)]",
                )}
              >
                <span
                  ref={setFloatingLabel}
                  className={cn(
                    "inline-flex items-center gap-2 transition-[translate] duration-250 ease-in-out-quart motion-reduce:transition-none",
                    !floatingDocked &&
                      "translate-x-[calc(50cqw-var(--pill)/2)]",
                  )}
                >
                  {saveLabel}
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </SplitLayout>
  );
}

function NotFoundCard() {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-3xl bg-white p-6 ring-1 ring-black/5"
    >
      <p className="font-bold">We could not find this Stremlist</p>
      <p className="text-sm text-black/60">
        Check that you opened the configure page from your Stremio install, or
        paste your Addon URL on the home page. You can also build a new
        Stremlist.
      </p>
      <Link
        to="/configure"
        className="inline-flex h-10 items-center rounded-full bg-brand px-5 text-sm font-bold text-black hover:bg-brand-dark"
      >
        Build a new Stremlist
      </Link>
    </div>
  );
}
