import { useId, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  ListPlus,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { joinProviderLabels, PROVIDERS } from "@stremlist/shared/providers";
import type {
  ActivityKind,
  WatchDestinationStatus,
  WatchProviderId,
} from "@stremlist/shared/watch-tracking";
import { WATCH_PROVIDERS } from "@stremlist/shared/watch-tracking";
import type { WatchChange, WatchChangeNotice } from "@/hooks/useWatchTracking";
import { cn } from "@/lib/utils";
import ActivityConsentDialog from "./ActivityConsentDialog";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ProviderMark } from "./brand";
import RelativeTime from "./RelativeTime";

const ALL_PROVIDERS = joinProviderLabels([...WATCH_PROVIDERS], "or");

function pad(value: number) {
  return String(value).padStart(2, "0");
}

type LineIcon = "busy" | "pause" | "alert" | "wait";

interface StatusLine {
  key: string;
  icon?: LineIcon;
  text: React.ReactNode;
}

function statusLine(
  destination: WatchDestinationStatus,
  change: WatchChange | null,
) {
  const { lastTitle } = destination;
  if (change?.provider === destination.provider) {
    return {
      key: "busy",
      icon: "busy",
      text: change.starting
        ? "Reading what you watched in Stremio…"
        : "Saving…",
    } satisfies StatusLine;
  }
  if (!destination.enabled && !destination.watchlistEnabled)
    return { key: "off", text: "Off" };
  if (destination.paused && !destination.watchlistEnabled) {
    return {
      key: "paused",
      icon: "pause",
      text: "Paused while Stremio's own Trakt is connected",
    } satisfies StatusLine;
  }
  switch (destination.lastError) {
    case "needs_renewal":
      return {
        key: "renew",
        icon: "alert",
        text: "Connect this account again to send waiting updates.",
      };
    case "gave_up":
      return {
        key: "gave-up",
        icon: "alert",
        text: "Some titles could not be sent for 3 days.",
      };
    case "not_found":
      return {
        key: "not-found",
        icon: "alert",
        text: "The last title was not found.",
      };
    case null:
      break;
  }
  if (destination.pending > 0) {
    return {
      key: "pending",
      icon: "wait",
      text:
        destination.pending === 1
          ? "1 title on its way"
          : `${destination.pending} titles on their way`,
    } satisfies StatusLine;
  }
  if (destination.lastSuccessAt && lastTitle) {
    const episode =
      lastTitle.season !== undefined && lastTitle.episode !== undefined
        ? `S${pad(lastTitle.season)}E${pad(lastTitle.episode)}, `
        : "";
    return {
      key: "last",
      text: (
        <>
          {destination.lastKind === "watchlist"
            ? "Last added: "
            : "Last marked: "}
          {episode}
          <RelativeTime iso={destination.lastSuccessAt} />
        </>
      ),
    } satisfies StatusLine;
  }
  return {
    key: "on",
    text: destination.enabled
      ? "On. Titles you finish from now on are marked."
      : "On. Library additions are sent from now on.",
  };
}

type Intent = { provider: WatchProviderId; kind: ActivityKind };
const ACTIONS = [
  {
    kind: "watched",
    title: "Mark as watched",
    lead: "When Stremio marks a title as watched.",
    icon: CircleCheck,
  },
  {
    kind: "watchlist",
    title: "Add to watchlist",
    lead: "New Stremio library additions. No removals.",
    icon: ListPlus,
  },
] as const;

export default function WatchTrackingSettings({
  destinations,
  consented,
  stremioLinked,
  stremioTrakt,
  loadFailed,
  busy,
  notice,
  locked,
  onToggle,
  onStop,
  onRetry,
  onRetryWrites,
  onLinkStremio,
  onManageAccounts,
  onInstallAgain,
  onUpdateStremio,
}: {
  destinations: WatchDestinationStatus[] | null;
  consented: boolean;
  stremioLinked: boolean;
  stremioTrakt: boolean;
  loadFailed: boolean;
  busy: WatchChange | null;
  notice: WatchChangeNotice;
  locked?: string;
  onToggle: (
    provider: WatchProviderId,
    enabled: boolean,
    kind: ActivityKind,
    consent?: boolean,
  ) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  onRetry: () => void;
  onRetryWrites: () => void;
  onLinkStremio: () => void;
  onManageAccounts: () => void;
  onInstallAgain: () => void;
  onUpdateStremio: () => void;
}) {
  const id = useId();
  const opener = useRef<HTMLElement>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [stopping, setStopping] = useState(false);
  const anyOn =
    destinations?.some((d) => d.enabled || d.watchlistEnabled) ?? false;
  const tracking = anyOn && !locked;
  const needsSetup =
    !locked &&
    destinations !== null &&
    (!stremioLinked || !destinations.length);
  const statuses = (destinations ?? [])
    .filter((d) => d.enabled || d.watchlistEnabled)
    .map((destination) => ({
      destination,
      line: statusLine(destination, busy),
    }));
  const pending = (destinations ?? []).reduce((sum, d) => sum + d.pending, 0);
  let body: React.ReactNode;
  if (locked) body = <Note>{locked}</Note>;
  else if (loadFailed && !destinations)
    body = (
      <Note>
        Stremlist could not load this setting.{" "}
        <Button
          variant="link-accent"
          size="inline"
          type="button"
          onClick={onRetry}
        >
          Try again
        </Button>
      </Note>
    );
  else if (!destinations)
    body = (
      <p className="flex items-center gap-2 text-sm text-black/50">
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </p>
    );
  else if (!stremioLinked)
    body = (
      <ActivitySetup
        action="Link Stremio"
        onStart={onLinkStremio}
        lead={
          anyOn
            ? "Link Stremio again to resume your updates."
            : "Start with Stremio. Then choose which accounts to update."
        }
      />
    );
  else if (!destinations.length)
    body = (
      <ActivitySetup
        action="Connect an account"
        onStart={onManageAccounts}
        lead={`Connect ${ALL_PROVIDERS}. You choose what gets shared.`}
      />
    );
  else
    body = (
      <>
        <div className="mt-4 divide-y divide-black/5">
          {ACTIONS.map((action) => (
            <div
              key={action.kind}
              className="grid gap-3 py-3.5 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] text-black/60">
                  <action.icon className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{action.title}</p>
                  <p className="mt-0.5 text-xs text-black/50">{action.lead}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {destinations.map((d) => {
                  const on =
                    action.kind === "watched" ? d.enabled : d.watchlistEnabled;
                  return (
                    <Toggle
                      key={d.provider}
                      pressed={on}
                      aria-label={`${action.title} on ${PROVIDERS[d.provider].label}`}
                      disabled={!!busy || loadFailed}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                      }}
                      onPressedChange={(next) => {
                        if (next && !consented)
                          setIntent({
                            provider: d.provider,
                            kind: action.kind,
                          });
                        else void onToggle(d.provider, next, action.kind);
                      }}
                      variant="chip"
                      size="chip"
                    >
                      <ProviderMark
                        provider={d.provider}
                        tone={on ? "dark" : "light"}
                        className={cn("size-7", !on && "opacity-50 grayscale")}
                      />
                      {PROVIDERS[d.provider].label}
                    </Toggle>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-1 border-t border-black/5 pt-3.5">
          {tracking ? (
            <Collapsible>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-black/55">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-success-500" />
                  {busy ? "Saving…" : "Sharing on"}
                </span>
                <div className="flex items-center gap-4">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="link-subtle"
                      size="inline-xs"
                      className="group"
                    >
                      Details
                      <ChevronDown
                        className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                        aria-hidden="true"
                      />
                    </Button>
                  </CollapsibleTrigger>
                  {!stopping && (
                    <Button
                      variant="link-danger"
                      size="inline-xs"
                      disabled={!!busy}
                      onClick={() => setStopping(true)}
                    >
                      Stop sharing
                    </Button>
                  )}
                </div>
              </div>
              {statuses
                .filter(({ line }) => line.icon === "alert")
                .map(({ destination, line }) => (
                  <p
                    key={destination.provider}
                    role="status"
                    className="mt-2 text-xs text-danger-700"
                  >
                    <strong className="font-semibold">
                      {PROVIDERS[destination.provider].label}:{" "}
                    </strong>
                    {line.text}
                  </p>
                ))}
              {pending > 0 && (
                <p className="mt-2 text-xs text-black/50">
                  {pending}{" "}
                  {pending === 1 ? "update waiting" : "updates waiting"}.{" "}
                  <Button
                    variant="link-accent"
                    size="inline"
                    disabled={!!busy}
                    onClick={onRetryWrites}
                  >
                    Retry now
                  </Button>
                </p>
              )}
              <CollapsibleContent>
                <div className="space-y-2 pt-3">
                  {statuses
                    .filter(({ line }) => line.icon !== "alert")
                    .map(({ destination, line }) => (
                      <p
                        key={destination.provider}
                        className="text-xs text-black/50"
                      >
                        <strong className="font-semibold">
                          {PROVIDERS[destination.provider].label}:{" "}
                        </strong>
                        {line.text}
                      </p>
                    ))}
                  <p className="text-xs text-pretty text-black/45">
                    Changes apply at once. Watched marks usually arrive within 5
                    minutes. Library additions need a Stremio app that sends
                    activity events.
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <p className="flex items-start gap-2 text-xs text-pretty text-black/50">
              <ShieldCheck className="mt-px size-4 shrink-0 text-black/35" />
              {consented
                ? "Sharing is off."
                : "Only new activity is shared, with your permission."}
            </p>
          )}
        </div>
      </>
    );
  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={!!busy}
      className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5"
    >
      <div className={cn(needsSetup && "flex items-start gap-3")}>
        {needsSetup && (
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-brand shadow-xs"
          >
            <ArrowRightLeft className="size-5" />
          </span>
        )}
        <div className="min-w-0">
          <h3
            id={`${id}-title`}
            className={cn(
              "font-bold",
              needsSetup && "tracking-tight text-balance",
            )}
          >
            Update your accounts from Stremio
          </h3>
          <p className="mt-0.5 text-sm text-pretty text-black/55">
            {needsSetup
              ? "Choose what to share, and where."
              : "Choose an account for each update."}
          </p>
        </div>
      </div>
      <div className={cn("mt-3", needsSetup && "mt-4")}>{body}</div>
      {(anyOn || consented) &&
        !locked &&
        (!stremioLinked || !destinations?.length) &&
        !stopping && (
          <div className="mt-4 flex justify-end border-t border-black/5 pt-3">
            <Button
              variant="link-danger"
              size="inline-xs"
              type="button"
              disabled={!!busy}
              onClick={() => setStopping(true)}
            >
              Stop sharing
            </Button>
          </div>
        )}
      {stopping && (
        <div
          role="group"
          aria-label="Stop sharing"
          className={cn(
            "rounded-2xl bg-danger-50 p-3 text-sm text-danger-900 ring-1 ring-danger-100",
            needsSetup && "mt-4",
          )}
        >
          <p className="font-bold">Stop sharing your Stremio activity?</p>
          <p className="mt-0.5 text-danger-900/75">
            Every account turns off and waiting updates are cancelled. What was
            already sent stays on your accounts.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="plain"
              size="pill"
              type="button"
              disabled={!!busy}
              onClick={() => setStopping(false)}
            >
              Keep sharing
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={!!busy}
              onClick={() => {
                void onStop().then((saved) => {
                  if (saved) setStopping(false);
                });
              }}
              size="pill"
            >
              {busy ? "Stopping…" : "Stop sharing"}
            </Button>
          </div>
        </div>
      )}
      <div role="status">
        {loadFailed && destinations && !locked && (
          <Note className="mt-3">
            Stremlist could not check this setting again, so it may be out of
            date.{" "}
            <Button
              variant="link-accent"
              size="inline"
              type="button"
              onClick={onRetry}
            >
              Try again
            </Button>
          </Note>
        )}
        {tracking && notice === "missing" && (
          <Note className="mt-3">
            Stremlist is not installed in your linked Stremio account.{" "}
            <Button
              variant="link-accent"
              size="inline"
              type="button"
              onClick={onInstallAgain}
            >
              Install it again
            </Button>
          </Note>
        )}
        {tracking && notice === "unavailable" && (
          <Note className="mt-3">
            Stremio did not take the update.{" "}
            <Button
              variant="link-accent"
              size="inline"
              type="button"
              onClick={onUpdateStremio}
            >
              Try again
            </Button>
          </Note>
        )}
        {tracking &&
          stremioTrakt &&
          destinations?.some((d) => d.provider === "trakt" && d.enabled) && (
            <Note className="mt-3">
              Stremio's own Trakt connection already marks what you finish, so
              Stremlist leaves watched marks to it. Watchlist additions stay
              separate.
            </Note>
          )}
      </div>
      <ActivityConsentDialog
        intent={intent}
        opener={opener}
        onCancel={() => setIntent(null)}
        onAllow={() => {
          if (intent) void onToggle(intent.provider, true, intent.kind, true);
          setIntent(null);
        }}
      />
    </section>
  );
}

function ActivitySetup({
  action,
  lead,
  onStart,
}: {
  action: string;
  lead: string;
  onStart: () => void;
}) {
  return (
    <div className="rounded-2xl bg-brand/10 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div aria-hidden="true" className="flex items-center gap-3">
          <span className="flex size-12 -rotate-6 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
            <img
              src="/stremio.png"
              alt=""
              width={36}
              height={36}
              className="size-9 rounded-xl"
            />
          </span>
          <ArrowRight className="size-4 text-black/30" />
          <div className="flex -space-x-3">
            {WATCH_PROVIDERS.map((provider) => (
              <ProviderMark
                key={provider}
                provider={provider}
                className="size-10 border-2 border-white shadow-sm"
              />
            ))}
          </div>
        </div>
        <Button type="button" size="pill" onClick={onStart}>
          {action}
          <ArrowUpRight aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-4 text-sm text-pretty text-black/60">{lead}</p>
    </div>
  );
}

function Note({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "rounded-2xl bg-black/5 px-4 py-3 text-sm text-pretty text-black/60",
        className,
      )}
    >
      {children}
    </p>
  );
}
