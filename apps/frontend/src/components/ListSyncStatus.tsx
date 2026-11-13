import type { ReactNode } from "react";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  sourceProblemCopy,
  storedSourceNoun,
} from "@stremlist/shared/source-problems";
import { useNow } from "@/hooks/useNow";
import { attentionTone, syncLineTone } from "@/lib/list-sync";
import type { ListSyncState } from "@/lib/list-sync";
import { queueLabel } from "@/lib/provider-queue";
import { cn } from "@/lib/utils";
import RelativeTime from "./RelativeTime";

const DOT: Record<ReturnType<typeof syncLineTone>, string> = {
  ok: "bg-emerald-500",
  idle: "bg-black/25",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};

function titles(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return "no titles";
  return count === 1 ? "1 title" : `${count.toLocaleString("en")} titles`;
}

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      <RelativeTime iso={iso} />
    </time>
  );
}

/** The queue state of a waiting List, while its wait is 3 s or more. */
function QueueText({
  queue,
  otherwise,
}: {
  queue: NonNullable<Extract<ListSyncState, { kind: "waiting" }>["queue"]>;
  otherwise: string;
}) {
  const now = useNow();
  const readyAt = Date.parse(queue.readyAt);
  return (
    queueLabel({ provider: queue.provider, since: readyAt, readyAt }, now) ??
    otherwise
  );
}

/**
 * One short line under a List's name: when it last refreshed, or what is
 * wrong. `saved` is false for a row that is not saved yet.
 */
export function ListSyncLine({
  provider: listProvider,
  sync,
  saved,
}: {
  /** The List's first Source list's Provider. */
  provider: ProviderId;
  sync: ListSyncState;
  saved: boolean;
}) {
  const tone = syncLineTone(sync, saved);
  let text: ReactNode;
  let pulse = false;
  if (sync.kind === "connection") {
    const label = PROVIDERS[sync.source?.provider ?? listProvider].label;
    text = sync.renew ? `${label} connection expired` : "Not connected";
  } else if (!saved) {
    text = "Not saved yet";
  } else if (sync.kind === "waiting") {
    pulse = true;
    const waiting = sync.reconnected
      ? "Checking the new connection"
      : "Not refreshed yet";
    text = sync.queue ? (
      <QueueText queue={sync.queue} otherwise={waiting} />
    ) : (
      waiting
    );
  } else if (sync.kind === "synced") {
    const count = titles(sync.titleCount);
    text = (
      <>
        Updated <Time iso={sync.at} />
        {count && ` · ${count}`}
      </>
    );
  } else if (sync.olderTitlesFrom) {
    text = (
      <>
        Refresh failed · titles from <Time iso={sync.olderTitlesFrom} />
      </>
    );
  } else if (sync.othersShown) {
    text = "One merged list does not show";
  } else {
    text = "Not showing in Stremio";
  }

  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-black/55 tabular-nums">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          DOT[tone],
          pulse && "motion-safe:animate-pulse",
        )}
      />
      <span className="truncate">{text}</span>
    </p>
  );
}

/**
 * What went wrong with a List and what the user can do, under its row.
 * Nothing when the List refreshes fine. In a merged List, the notice is
 * about the Source list that has the problem (`sync.source`).
 */
export function ListSyncNotice({
  title,
  provider: listProvider,
  sourceRef: listSourceRef,
  sync,
  onConnect,
}: {
  /** The List's name, so its button names the List it renews. */
  title: string;
  /** The List's first Source list. */
  provider: ProviderId;
  sourceRef: string;
  sync: ListSyncState;
  /** Start the Connection again; absent when it cannot be started here. */
  onConnect?: () => void;
}) {
  if (sync.kind !== "connection" && sync.kind !== "failing") return null;
  const provider = sync.source?.provider ?? listProvider;
  const sourceRef = sync.source?.sourceRef ?? listSourceRef;
  const label = PROVIDERS[provider].label;
  const severe = attentionTone(sync) === "bad";
  let body: ReactNode;

  if (sync.kind === "connection") {
    const subject = sync.source
      ? {
          noun: "one of its lists",
          lastRefresh: "the last refresh",
          hidden: "one of its lists does not show in this catalog",
        }
      : {
          noun: "this list",
          lastRefresh: "its last refresh",
          hidden: "this list does not show in Stremio",
        };
    body = sync.renew ? (
      <>
        <strong className="font-semibold">
          Your {label} connection expired
        </strong>
        {sync.stillShown
          ? `. Stremio still shows ${subject.noun} from ${subject.lastRefresh}, but not after the next one.`
          : `, so ${subject.hidden}.`}{" "}
        Connect {label} again to fix it.
      </>
    ) : (
      `${label} is not connected, so ${subject.hidden}.`
    );
  } else {
    const copy = sourceProblemCopy(
      provider,
      sync.problem,
      storedSourceNoun(provider, sourceRef),
      sourceRef,
    );
    const fix =
      sync.problem === "needs_connection"
        ? `Connect ${label} in the Providers panel.`
        : copy.fix;
    body = (
      <>
        <strong className="font-semibold">{copy.title}.</strong> {fix}{" "}
        <span className="opacity-80">
          {sync.olderTitlesFrom ? (
            <>
              Stremio shows the titles from the last refresh,{" "}
              <Time iso={sync.olderTitlesFrom} />.
            </>
          ) : (
            <>
              {sync.othersShown &&
                "Stremio shows the titles of its other lists. "}
              This problem started <Time iso={sync.since} />.
            </>
          )}
        </span>
      </>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "mx-3 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-2.5 text-sm ring-1 sm:mx-4 sm:mb-4",
        // Appears when a refresh reports a problem; no movement when the
        // user prefers reduced motion.
        "transition-[opacity,translate] duration-200 ease-out-quint starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0",
        severe
          ? "bg-red-50 text-red-900 ring-red-200"
          : "bg-amber-50 text-amber-900 ring-amber-200",
      )}
    >
      <p className="min-w-0 flex-1 text-pretty tabular-nums">{body}</p>
      {sync.kind === "connection" && onConnect && (
        // "Connect again" only for a connection that existed and expired;
        // a Provider that is not connected gets a plain "Connect".
        <button
          type="button"
          onClick={onConnect}
          aria-label={
            sync.renew
              ? `Connect again for ${title}`
              : `Connect ${label} for ${title}`
          }
          className="inline-flex h-8 shrink-0 items-center rounded-full bg-brand px-3 text-xs font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.96]"
        >
          {sync.renew ? "Connect again" : `Connect ${label}`}
        </button>
      )}
    </div>
  );
}
