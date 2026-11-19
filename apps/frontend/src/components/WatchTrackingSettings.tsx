import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, Loader2, ShieldCheck } from "lucide-react";
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

const LINK_HIT_AREA =
  "relative after:absolute after:-inset-x-2 after:-inset-y-3";

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

const KINDS = [
  { kind: "watched", label: "Watched", action: "Mark as watched" },
  { kind: "watchlist", label: "Watchlist", action: "Add to watchlist" },
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
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement>(null);
  const stopTrigger = useRef<HTMLButtonElement>(null);
  const keepSharing = useRef<HTMLButtonElement>(null);
  const stopConfirmation = useRef<HTMLDivElement>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [stopping, setStopping] = useState(false);
  const anyOn =
    destinations?.some((d) => d.enabled || d.watchlistEnabled) ?? false;
  const tracking = anyOn && !locked;
  const statuses = (destinations ?? [])
    .filter((d) => d.enabled || d.watchlistEnabled)
    .map((destination) => ({
      destination,
      line: statusLine(destination, busy),
    }));
  const pending = (destinations ?? []).reduce((sum, d) => sum + d.pending, 0);

  const askToStop = () => {
    flushSync(() => setStopping(true));
    keepSharing.current?.focus();
  };
  const keepOn = () => {
    flushSync(() => setStopping(false));
    stopTrigger.current?.focus();
  };
  const stopLink = (
    <Button
      ref={stopTrigger}
      variant="link-danger"
      size="inline-xs"
      type="button"
      className={LINK_HIT_AREA}
      disabled={!!busy}
      onClick={askToStop}
    >
      Stop sharing
    </Button>
  );

  let body: React.ReactNode;
  if (locked) body = <Note className="mt-4">{locked}</Note>;
  else if (loadFailed && !destinations)
    body = (
      <Note className="mt-4">
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
      <p className="mt-4 flex items-center gap-2 text-sm text-black/50">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading…
      </p>
    );
  else if (!stremioLinked)
    body = (
      <SetupStep
        visual={
          <img
            src="/stremio.png"
            alt=""
            width={32}
            height={32}
            className="size-8"
          />
        }
        title={anyOn ? "Stremio is not linked" : "Start with Stremio"}
        lead={
          anyOn
            ? "Link it again to resume your updates."
            : "Then choose which accounts to update."
        }
        action="Link Stremio"
        onStart={onLinkStremio}
      />
    );
  else if (!destinations.length)
    body = (
      <SetupStep
        visual={
          <span className="flex -space-x-2">
            {WATCH_PROVIDERS.map((provider) => (
              <ProviderMark
                key={provider}
                provider={provider}
                className="size-8 border-2 border-white"
              />
            ))}
          </span>
        }
        title={`Connect ${ALL_PROVIDERS}`}
        lead="You choose what gets shared."
        action="Connect an account"
        onStart={onManageAccounts}
      />
    );
  else
    body = (
      <>
        <ul className="mt-4 space-y-1.5">
          {destinations.map((d) => {
            const label = PROVIDERS[d.provider].label;
            return (
              <li
                key={d.provider}
                className="flex flex-wrap items-center gap-1 rounded-2xl bg-black/[0.03] p-1"
              >
                <span className="flex flex-1 items-center gap-2.5 py-1 pl-1">
                  <ProviderMark
                    provider={d.provider}
                    active={d.enabled || d.watchlistEnabled}
                    className="size-7"
                  />
                  <span className="text-sm font-semibold">{label}</span>
                </span>
                <span className="ml-auto grid w-full grid-cols-2 gap-1 @3xs:flex @3xs:w-auto">
                  {KINDS.map(({ kind, label: choice, action }) => (
                    <Toggle
                      key={kind}
                      variant="option"
                      size="option"
                      pressed={
                        kind === "watched" ? d.enabled : d.watchlistEnabled
                      }
                      aria-label={`${action} on ${label}`}
                      disabled={loadFailed}
                      aria-disabled={!!busy || undefined}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                      }}
                      onPressedChange={(next) => {
                        if (busy) return;
                        if (next && !consented)
                          setIntent({ provider: d.provider, kind });
                        else void onToggle(d.provider, next, kind);
                      }}
                    >
                      {choice}
                    </Toggle>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-3">
          {tracking ? (
            <Collapsible>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-black/55">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full bg-success-500"
                  />
                  {busy ? "Saving…" : "Sharing on"}
                </span>
                <div className="flex items-center gap-4">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="link-subtle"
                      size="inline-xs"
                      className={cn("group", LINK_HIT_AREA)}
                    >
                      Details
                      <ChevronDown
                        className="size-3.5 transition-transform duration-200 ease-out-quint group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    </Button>
                  </CollapsibleTrigger>
                  {!stopping && stopLink}
                </div>
              </div>
              {statuses
                .filter(({ line }) => line.icon === "alert")
                .map(({ destination, line }) => (
                  <p
                    key={destination.provider}
                    role="status"
                    className="mt-2 text-xs text-pretty text-danger-700"
                  >
                    <strong className="font-semibold">
                      {PROVIDERS[destination.provider].label}:{" "}
                    </strong>
                    {line.text}
                  </p>
                ))}
              {pending > 0 && (
                <p className="mt-2 text-xs text-black/50 tabular-nums">
                  {pending}{" "}
                  {pending === 1 ? "update waiting" : "updates waiting"}.{" "}
                  <Button
                    variant="link-accent"
                    size="inline-xs"
                    disabled={!!busy}
                    onClick={onRetryWrites}
                  >
                    Retry now
                  </Button>
                </p>
              )}
              <CollapsibleContent>
                <div className="space-y-1.5 pt-3 text-xs text-pretty text-black/50">
                  {statuses
                    .filter(({ line }) => line.icon !== "alert")
                    .map(({ destination, line }) => (
                      <p key={destination.provider}>
                        <strong className="font-semibold text-black/60">
                          {PROVIDERS[destination.provider].label}:{" "}
                        </strong>
                        {line.text}
                      </p>
                    ))}
                  <p className="text-black/45">
                    Watched marks usually arrive within 5 minutes. Library
                    additions need a Stremio app that sends activity events.
                    Removals are not sent.
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <p className="flex items-start gap-2 text-xs text-pretty text-black/50">
              <ShieldCheck
                className="size-4 shrink-0 text-black/35"
                aria-hidden="true"
              />
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
      className="@container rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5"
    >
      <h3
        ref={heading}
        id={`${id}-title`}
        tabIndex={-1}
        className="font-bold text-balance outline-none"
      >
        Update your accounts from Stremio
      </h3>
      <p className="mt-0.5 text-sm text-pretty text-black/55">
        Mark titles you finish as watched and add new library titles to your
        watchlist.
      </p>
      {body}
      {(anyOn || consented) &&
        !locked &&
        (!stremioLinked || !destinations?.length) &&
        !stopping && <div className="mt-3 flex justify-end">{stopLink}</div>}
      {stopping && (
        <div
          ref={stopConfirmation}
          role="group"
          aria-label="Stop sharing"
          className="mt-3 flex flex-col gap-3 rounded-2xl bg-danger-50 p-3 ring-1 ring-danger-100 transition-[opacity,translate] duration-200 ease-out-quint starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0 @lg:flex-row @lg:items-center @lg:gap-4 @lg:pl-4"
        >
          <div className="min-w-0 flex-1 text-danger-900">
            <p className="text-sm font-semibold">
              Stop sharing your Stremio activity?
            </p>
            <p className="mt-0.5 text-xs text-pretty text-danger-900/75">
              Every account turns off and waiting updates are cancelled. What
              was already sent stays on your accounts.
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2 @lg:flex">
            <Button
              ref={keepSharing}
              variant="plain"
              size="pill"
              type="button"
              disabled={!!busy}
              onClick={keepOn}
            >
              Keep sharing
            </Button>
            <Button
              variant="destructive"
              size="pill"
              type="button"
              disabled={!!busy}
              onClick={() => {
                void onStop().then((saved) => {
                  if (!saved) return;
                  const restoreFocus =
                    document.activeElement === document.body ||
                    stopConfirmation.current?.contains(document.activeElement);
                  flushSync(() => setStopping(false));
                  if (restoreFocus) heading.current?.focus();
                });
              }}
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

function SetupStep({
  visual,
  title,
  lead,
  action,
  onStart,
}: {
  visual: React.ReactNode;
  title: string;
  lead: string;
  action: string;
  onStart: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl bg-black/[0.03] p-3 @md:flex-row @md:items-center @md:gap-4 @md:pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden="true" className="flex shrink-0">
          {visual}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-pretty">{title}</p>
          <p className="mt-0.5 text-xs text-pretty text-black/50">{lead}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="dark"
        size="pill"
        className="w-full @md:w-auto"
        onClick={onStart}
      >
        {action}
      </Button>
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
