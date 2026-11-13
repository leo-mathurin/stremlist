import { useId } from "react";
import { AlertCircle, Clock, Loader2, PauseCircle } from "lucide-react";
import { joinProviderLabels, PROVIDERS } from "@stremlist/shared/providers";
import type {
  WatchDestinationStatus,
  WatchProviderId,
} from "@stremlist/shared/watch-tracking";
import { WATCH_PROVIDERS } from "@stremlist/shared/watch-tracking";
import type { WatchChange, WatchChangeNotice } from "@/hooks/useWatchTracking";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { BRAND_CHECKBOX } from "./ActionsSettings";
import { ProviderMark } from "./brand";
import RelativeTime from "./RelativeTime";
import { ENTER } from "./StremioUpdateNotice";

const ALL_PROVIDERS = joinProviderLabels([...WATCH_PROVIDERS], "or");

const LINK_BUTTON = "font-semibold text-stremlist hover:underline";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

type LineIcon = "busy" | "pause" | "alert" | "wait";

interface StatusLine {
  key: string;
  icon?: LineIcon;
  text: React.ReactNode;
}

/** What an account shows under its name. */
function statusLine(
  destination: WatchDestinationStatus,
  change: WatchChange | null,
): StatusLine {
  const label = PROVIDERS[destination.provider].label;
  const { lastTitle } = destination;
  if (change?.provider === destination.provider) {
    return {
      key: "busy",
      icon: "busy",
      text: change.starting
        ? "Reading what you watched in Stremio…"
        : "Saving…",
    };
  }
  if (!destination.enabled) return { key: "off", text: "Off" };
  if (destination.paused) {
    return {
      key: "paused",
      icon: "pause",
      text: "Paused while Stremio's own Trakt is connected",
    };
  }
  switch (destination.lastError) {
    case "needs_renewal":
      return {
        key: "renew",
        icon: "alert",
        text: `Connect ${label} again to send the titles waiting`,
      };
    case "gave_up":
      return {
        key: "gave-up",
        icon: "alert",
        text: `${label} refused some titles for 3 days. They were not sent.`,
      };
    case "not_found":
      return {
        key: "not-found",
        icon: "alert",
        text: `${label} could not find the last title`,
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
    };
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
          Last marked: {episode}
          <RelativeTime iso={destination.lastSuccessAt} />
        </>
      ),
    };
  }
  return { key: "on", text: "On. Titles you finish from now on are marked." };
}

/**
 * Automatic watched marks (ADR 0003): Stremlist marks what Stremio marks as
 * watched on the accounts the member picks. Changes apply at once, not on
 * Save.
 */
export default function WatchTrackingSettings({
  destinations,
  stremioLinked,
  stremioTrakt,
  loadFailed,
  busy,
  notice,
  locked,
  onToggle,
  onRetry,
  onLinkStremio,
  onInstallAgain,
  onUpdateStremio,
}: {
  /** Null while the first answer is on its way. */
  destinations: WatchDestinationStatus[] | null;
  stremioLinked: boolean;
  stremioTrakt: boolean;
  loadFailed: boolean;
  busy: WatchChange | null;
  notice: WatchChangeNotice;
  /** Why this cannot be used here, if it cannot. */
  locked?: string;
  onToggle: (provider: WatchProviderId, enabled: boolean) => void;
  onRetry: () => void;
  onLinkStremio: () => void;
  onInstallAgain: () => void;
  onUpdateStremio: () => void;
}) {
  const id = useId();
  const anyOn = destinations?.some((d) => d.enabled) ?? false;

  let body: React.ReactNode;
  if (locked) {
    body = <Note>{locked}</Note>;
  } else if (loadFailed && !destinations) {
    body = (
      <Note>
        Stremlist could not load this setting.{" "}
        <button type="button" onClick={onRetry} className={LINK_BUTTON}>
          Try again
        </button>
      </Note>
    );
  } else if (!destinations) {
    body = (
      <p className="flex items-center gap-2 text-sm text-black/50">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  } else if (!stremioLinked) {
    body = (
      <Note>
        {anyOn
          ? "Stremio is not linked any more, so nothing is marked until you link it again."
          : "Link your Stremio account first: it is how Stremlist sees what you watch."}{" "}
        <button type="button" onClick={onLinkStremio} className={LINK_BUTTON}>
          Link Stremio
        </button>
      </Note>
    );
  } else if (destinations.length === 0) {
    body = <Note>{`Connect ${ALL_PROVIDERS} to use this.`}</Note>;
  } else {
    body = (
      <ul className="space-y-1.5">
        {destinations.map((destination) => {
          const rowId = `${id}-${destination.provider}`;
          const isBusy = busy?.provider === destination.provider;
          const line = statusLine(destination, busy);
          return (
            <li
              key={destination.provider}
              aria-busy={isBusy}
              className="flex items-start gap-3 rounded-2xl bg-black/[0.03] px-3 py-2"
            >
              <Checkbox
                id={rowId}
                aria-labelledby={`${rowId}-name`}
                aria-describedby={`${rowId}-line`}
                checked={destination.enabled}
                // The row being saved keeps focus; the hook ignores clicks
                // until its answer comes.
                disabled={(busy !== null && !isBusy) || loadFailed}
                onCheckedChange={(next) =>
                  onToggle(destination.provider, next === true)
                }
                className={cn("mt-2", BRAND_CHECKBOX)}
              />
              <ProviderMark
                provider={destination.provider}
                active={destination.enabled && !destination.paused}
                className="size-7 shrink-0"
              />
              <label
                htmlFor={rowId}
                className="min-w-0 flex-1 cursor-pointer leading-tight"
              >
                <span
                  id={`${rowId}-name`}
                  className="block text-sm font-semibold"
                >
                  {PROVIDERS[destination.provider].label}
                </span>
                <span
                  id={`${rowId}-line`}
                  key={line.key}
                  className={cn(
                    "mt-0.5 flex items-start gap-1 text-xs text-pretty",
                    line.icon === "alert"
                      ? "text-red-700"
                      : line.icon === "pause"
                        ? "text-amber-700"
                        : "text-black/50",
                    ENTER,
                  )}
                >
                  {line.icon === "busy" && (
                    <Loader2 className="mt-px size-3 shrink-0 animate-spin" />
                  )}
                  {line.icon === "pause" && (
                    <PauseCircle className="mt-px size-3 shrink-0" />
                  )}
                  {line.icon === "alert" && (
                    <AlertCircle className="mt-px size-3 shrink-0" />
                  )}
                  {line.icon === "wait" && (
                    <Clock className="mt-px size-3 shrink-0" />
                  )}
                  <span>{line.text}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    );
  }

  const tracking = anyOn && !locked;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5"
    >
      <h3 id={`${id}-title`} className="font-bold">
        Mark as watched automatically
      </h3>
      <p className="mt-0.5 mb-3 text-sm text-pretty text-black/55">
        When Stremio marks a movie or an episode as watched, Stremlist marks it
        on the accounts you choose, usually within 5 minutes. What you watched
        before you turn this on is not sent. Changes here apply at once, without
        Save.
      </p>

      {body}

      {/* One stable region, so screen readers hear each notice. */}
      <div role="status">
        {loadFailed && destinations && !locked && (
          <Note className={cn("mt-3", ENTER)}>
            Stremlist could not check this setting again, so it may be out of
            date.{" "}
            <button type="button" onClick={onRetry} className={LINK_BUTTON}>
              Try again
            </button>
          </Note>
        )}
        {tracking && notice === "missing" && (
          <Note className={cn("mt-3", ENTER)}>
            Stremlist is not installed in your linked Stremio account, so titles
            are found only every 6 hours.{" "}
            <button
              type="button"
              onClick={onInstallAgain}
              className={LINK_BUTTON}
            >
              Install it again
            </button>
          </Note>
        )}
        {tracking && notice === "unavailable" && (
          <Note className={cn("mt-3", ENTER)}>
            Stremio did not take the update, so titles are found only every 6
            hours for now.{" "}
            <button
              type="button"
              onClick={onUpdateStremio}
              className={LINK_BUTTON}
            >
              Try again
            </button>
          </Note>
        )}
        {tracking &&
          stremioTrakt &&
          destinations?.some((d) => d.provider === "trakt" && d.enabled) && (
            <Note className={cn("mt-3", ENTER)}>
              Stremio's own Trakt connection already marks what you finish, so
              Stremlist leaves Trakt to it. It misses what you close before the
              end: disconnect Trakt in Stremio's settings to let Stremlist do
              it.
            </Note>
          )}
      </div>
      {tracking && (
        <p className="mt-3 text-xs text-pretty text-black/45">
          Works with every Stremio app. A play that the app could not save, for
          example when it was force-closed, is not seen.
        </p>
      )}
    </section>
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
