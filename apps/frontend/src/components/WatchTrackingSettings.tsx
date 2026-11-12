import { useId } from "react";
import { AlertCircle, Clock, Loader2, PauseCircle } from "lucide-react";
import { joinProviderLabels, PROVIDERS } from "@stremlist/shared/providers";
import type {
  WatchDestinationStatus,
  WatchProviderId,
} from "@stremlist/shared/watch-tracking";
import { WATCH_PROVIDERS } from "@stremlist/shared/watch-tracking";
import type { WatchChangeNotice } from "@/hooks/useWatchTracking";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { BRAND_CHECKBOX } from "./ActionsSettings";
import { ProviderMark } from "./brand";
import RelativeTime from "./RelativeTime";

/** A status line fades in when it changes, from just below. */
const ENTER =
  "transition-[opacity,translate] duration-200 ease-[var(--ease-out-quint)] starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0";

const ALL_PROVIDERS = joinProviderLabels([...WATCH_PROVIDERS], "or");

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** What a Destination shows under its name. */
function DestinationLine({
  destination,
  busy,
  first,
}: {
  destination: WatchDestinationStatus;
  busy: boolean;
  /** This change turns Watch tracking on: it reads the library first. */
  first: boolean;
}) {
  const label = PROVIDERS[destination.provider].label;
  const { lastTitle } = destination;
  let line: {
    key: string;
    icon?: "busy" | "pause" | "alert" | "wait";
    text: React.ReactNode;
  };

  if (busy) {
    line = {
      key: "busy",
      icon: "busy",
      text: first ? "Reading what you watched in Stremio…" : "Saving…",
    };
  } else if (!destination.enabled) {
    line = { key: "off", text: "Off" };
  } else if (destination.paused) {
    line = {
      key: "paused",
      icon: "pause",
      text: "Paused while Stremio's own Trakt is connected",
    };
  } else if (destination.lastError === "needs_renewal") {
    line = {
      key: "renew",
      icon: "alert",
      text: `Connect ${label} again to send the titles waiting`,
    };
  } else if (destination.lastError === "gave_up") {
    line = {
      key: "gave-up",
      icon: "alert",
      text: `${label} refused some titles for 3 days. They were not sent.`,
    };
  } else if (destination.lastError === "not_found") {
    line = {
      key: "not-found",
      icon: "alert",
      text: `${label} does not know the last title`,
    };
  } else if (destination.pending > 0) {
    line = {
      key: "pending",
      icon: "wait",
      text:
        destination.pending === 1
          ? "1 title on its way"
          : `${destination.pending} titles on their way`,
    };
  } else if (destination.lastSuccessAt && lastTitle) {
    line = {
      key: "last",
      text: (
        <>
          Last marked{" "}
          {lastTitle.season !== undefined && lastTitle.episode !== undefined
            ? `S${pad(lastTitle.season)}E${pad(lastTitle.episode)} `
            : ""}
          <RelativeTime iso={destination.lastSuccessAt} />
        </>
      ),
    };
  } else {
    line = { key: "on", text: "On. Titles you finish from now on go here." };
  }

  return (
    <span
      key={line.key}
      className={cn(
        "flex items-center gap-1 text-xs",
        line.icon === "alert" ? "text-red-700" : "text-black/50",
        line.icon === "pause" && "text-amber-700",
        ENTER,
      )}
    >
      {line.icon === "busy" && (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      )}
      {line.icon === "pause" && <PauseCircle className="size-3 shrink-0" />}
      {line.icon === "alert" && <AlertCircle className="size-3 shrink-0" />}
      {line.icon === "wait" && <Clock className="size-3 shrink-0" />}
      <span className="min-w-0 truncate">{line.text}</span>
    </span>
  );
}

/**
 * Watch tracking (ADR 0003): Stremlist marks what Stremio marks as watched
 * on the accounts the member picks. Changes apply at once, not on Save.
 */
export default function WatchTrackingSettings({
  destinations,
  stremioLinked,
  stremioTrakt,
  loadFailed,
  busy,
  starting,
  notice,
  locked,
  onToggle,
  onRetry,
  onLinkStremio,
}: {
  /** Null while the first answer is on its way. */
  destinations: WatchDestinationStatus[] | null;
  stremioLinked: boolean;
  stremioTrakt: boolean;
  loadFailed: boolean;
  busy: WatchProviderId | null;
  /** The running change turns Watch tracking on. */
  starting: boolean;
  notice: WatchChangeNotice;
  /** Why Watch tracking cannot be used here, if it cannot. */
  locked?: string;
  onToggle: (provider: WatchProviderId, enabled: boolean) => void;
  onRetry: () => void;
  onLinkStremio: () => void;
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
        <button
          type="button"
          onClick={onRetry}
          className="font-semibold text-stremlist hover:underline"
        >
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
        Link your Stremio account first: it is how Stremlist sees what you
        watch.{" "}
        <button
          type="button"
          onClick={onLinkStremio}
          className="font-semibold text-stremlist hover:underline"
        >
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
          const checkboxId = `${id}-${destination.provider}`;
          const isBusy = busy === destination.provider;
          return (
            <li
              key={destination.provider}
              className="flex items-center gap-3 rounded-2xl bg-black/[0.03] px-3 py-2"
            >
              <Checkbox
                id={checkboxId}
                checked={destination.enabled}
                disabled={busy !== null || loadFailed}
                onCheckedChange={(next) =>
                  onToggle(destination.provider, next === true)
                }
                className={BRAND_CHECKBOX}
              />
              <ProviderMark
                provider={destination.provider}
                active={destination.enabled && !destination.paused}
                className="size-7"
              />
              <label
                htmlFor={checkboxId}
                className="min-w-0 flex-1 cursor-pointer leading-tight"
              >
                <span className="block text-sm font-semibold">
                  {PROVIDERS[destination.provider].label}
                </span>
                <DestinationLine
                  destination={destination}
                  busy={isBusy}
                  first={starting}
                />
              </label>
            </li>
          );
        })}
      </ul>
    );
  }

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
        before you turn this on is not sent.
      </p>

      {body}

      {loadFailed && destinations && !locked && (
        <Note className={cn("mt-3", ENTER)}>
          Stremlist could not check this setting again, so it may be out of
          date.{" "}
          <button
            type="button"
            onClick={onRetry}
            className="font-semibold text-stremlist hover:underline"
          >
            Try again
          </button>
        </Note>
      )}

      {notice === "missing" && (
        <Note className={cn("mt-3", ENTER)}>
          Stremlist is not installed in your linked Stremio account, so titles
          are found only every 6 hours. Install it again with your Addon URL
          below.
        </Note>
      )}
      {notice === "stremio-unavailable" && (
        <Note className={cn("mt-3", ENTER)}>
          Stremio did not take the update yet. Titles are found every 6 hours
          until your next save updates Stremio.
        </Note>
      )}
      {stremioTrakt &&
        destinations?.some((d) => d.provider === "trakt" && d.enabled) && (
          <Note className={cn("mt-3", ENTER)}>
            Stremio's own Trakt connection already marks what you finish, so
            Stremlist leaves Trakt to it. It misses what you close before the
            end: disconnect it in Stremio's settings to let Stremlist do it.
          </Note>
        )}
      {anyOn && (
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
