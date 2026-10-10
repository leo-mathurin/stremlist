import type { ReactNode } from "react";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  sourceProblemCopy,
  storedSourceNoun,
} from "@stremlist/shared/source-problems";
import { attentionTone } from "@/lib/list-sync";
import type { ListSyncState } from "@/lib/list-sync";
import { cn, formatRelativeTime } from "@/lib/utils";

type Tone = "ok" | "idle" | "warn" | "bad";

const DOT: Record<Tone, string> = {
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
      {formatRelativeTime(iso)}
    </time>
  );
}

/**
 * One short line under a List's name: when it last refreshed, or what is
 * wrong. `saved` is false for a row that is not saved yet.
 */
export function ListSyncLine({
  sync,
  saved,
}: {
  sync: ListSyncState;
  saved: boolean;
}) {
  let tone: Tone;
  let text: ReactNode;
  let pulse = false;
  if (sync.kind === "connection") {
    tone = sync.renew && !sync.othersShown ? "bad" : "warn";
    text = sync.renew ? "Connection needs to be renewed" : "Not connected";
  } else if (!saved) {
    tone = "idle";
    text = "Not saved yet";
  } else if (sync.kind === "waiting") {
    tone = "idle";
    pulse = true;
    text = sync.reconnected
      ? "Checking the new Connection"
      : "Not refreshed yet";
  } else if (sync.kind === "synced") {
    tone = "ok";
    const count = titles(sync.titleCount);
    text = (
      <>
        Updated <Time iso={sync.at} />
        {count && ` · ${count}`}
      </>
    );
  } else if (sync.olderTitlesFrom) {
    tone = "warn";
    text = (
      <>
        Refresh failed · titles from <Time iso={sync.olderTitlesFrom} />
      </>
    );
  } else if (sync.othersShown) {
    tone = "warn";
    text = "One Source list does not show";
  } else {
    tone = "bad";
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

  if (sync.kind === "connection" && sync.source) {
    body = sync.renew ? (
      <>
        <strong className="font-semibold">
          {label} refused the Stremlist Connection
        </strong>
        {sync.stillShown
          ? ". Stremio still shows its Source list from the last refresh, but not after the next one."
          : ", so its Source list does not show in this catalog."}{" "}
        Connect {label} again to renew it.
      </>
    ) : (
      <>
        {label} is not connected, so its Source list does not show in this
        catalog.
      </>
    );
  } else if (sync.kind === "connection") {
    body = sync.renew ? (
      <>
        <strong className="font-semibold">
          {label} refused the Stremlist Connection
        </strong>
        {sync.stillShown
          ? ". Stremio still shows this List from its last refresh, but not after the next one."
          : ", so this List does not show in Stremio."}{" "}
        Connect {label} again to renew it.
      </>
    ) : (
      <>{label} is not connected, so this List does not show in Stremio.</>
    );
  } else {
    const copy = sourceProblemCopy(
      provider,
      sync.problem,
      storedSourceNoun(provider, sourceRef),
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
          ) : sync.othersShown ? (
            <>
              Stremio shows the titles of the other Source lists. This problem
              started <Time iso={sync.since} />.
            </>
          ) : (
            <>
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
        <button
          type="button"
          onClick={onConnect}
          aria-label={`Connect again for ${title}`}
          className="inline-flex h-8 shrink-0 items-center rounded-full bg-brand px-3 text-xs font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.96]"
        >
          Connect again
        </button>
      )}
    </div>
  );
}
