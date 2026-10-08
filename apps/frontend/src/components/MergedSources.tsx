import { useEffect, useRef } from "react";
import {
  MAX_SOURCES_PER_LIST,
  isMergedList,
  listSources,
  singleTypeReason,
  sourceKey,
  sourcesWithVerb,
  sourcesWithoutDates,
} from "@stremlist/shared/list-merge";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { ChevronDown, ExternalLink, Merge, Split, X } from "lucide-react";
import { rowTitle } from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { describeSource } from "../lib/list-sources";
import { ProviderMark } from "./brand";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface MergeControls {
  /** The other Lists of the Account, which can be merged into this one. */
  others: ListFormRow[];
  /** False when the Account has no room for one more List. */
  canSplit: boolean;
  onMerge: (localId: string, otherLocalId: string) => void;
  onRemoveSource: (localId: string, index: number) => void;
  onSplitSource: (localId: string, index: number) => void;
}

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-full text-black/40 transition-[color,background-color,scale] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";

/**
 * The Source lists of a List, and the control that merges another List
 * into it. Titles that several Source lists share show once (ADR 0006).
 */
export default function MergedSources({
  list,
  missingProviders,
  controls,
}: {
  list: ListFormRow;
  /** Providers of this List whose Connection is missing. */
  missingProviders: ProviderId[];
  controls: MergeControls;
}) {
  const sources = listSources(list);
  // The buttons and the picker that the user pressed go away when the
  // Source lists change, so keyboard focus moves to the new picker.
  const picker = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const keepFocus = useRef(false);
  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    // Without other Lists there is no menu: focus the section instead.
    // A full List disables the menu, which then cannot take focus either.
    const menu = picker.current;
    (menu && !menu.disabled ? menu : heading.current)?.focus();
  }, [sources.length]);
  const changeSources = (change: () => void) => {
    keepFocus.current = true;
    change();
  };
  const merged = isMergedList(list);
  const room = MAX_SOURCES_PER_LIST - sources.length;
  const undated = sourcesWithoutDates(list);
  const showHint = singleTypeReason(list, {
    both: "this List shows both",
    movie: '"TV shows only" is off',
    series: '"Movies only" is off',
  });

  return (
    <div className="mt-4 border-t border-black/5 pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <p
          ref={heading}
          tabIndex={-1}
          className="text-xs font-semibold text-black/60 outline-none"
        >
          Source lists
        </p>
        <p className="text-xs text-black/45 tabular-nums">
          {sources.length} of {MAX_SOURCES_PER_LIST}
        </p>
      </div>

      {merged && (
        <ul className="mt-2 divide-y divide-black/5 rounded-2xl ring-1 ring-black/5">
          {sources.map((source, index) => {
            const description = describeSource(
              source.provider,
              source.sourceRef,
            );
            const label = PROVIDERS[source.provider].label;
            const name = source.label ?? description.suggestedTitle;
            const missing = missingProviders.includes(source.provider);
            return (
              <li
                key={sourceKey(source)}
                className="flex items-center gap-3 px-3 py-2 transition-[opacity,translate] duration-200 ease-out-quint starting:translate-y-1 starting:opacity-0 motion-reduce:translate-y-0 motion-reduce:transition-opacity"
              >
                <ProviderMark provider={source.provider} className="size-7" />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <span className="truncate">{name}</span>
                    {missing && (
                      <Badge
                        variant="outline"
                        className="border-amber-300 bg-amber-50 text-amber-900"
                      >
                        Not connected
                      </Badge>
                    )}
                  </p>
                  <p className="flex min-w-0 items-center gap-1 text-xs text-black/50">
                    <span className="truncate">
                      {label} · {description.kindLabel}
                      {description.detail ? ` · ${description.detail}` : ""}
                    </span>
                    {description.url && (
                      <a
                        href={description.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${name} on ${label}`}
                        title={`Open on ${label}`}
                        className="shrink-0 rounded p-0.5 text-black/40 transition-colors hover:text-stremlist"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    changeSources(() =>
                      controls.onSplitSource(list.localId, index),
                    )
                  }
                  disabled={!controls.canSplit}
                  aria-label={`Move ${name} to its own List`}
                  title={
                    controls.canSplit
                      ? "Move to its own List"
                      : "You have the maximum number of lists"
                  }
                  className={cn(ICON_BUTTON, "hover:bg-black/5 hover:text-ink")}
                >
                  <Split className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    changeSources(() =>
                      controls.onRemoveSource(list.localId, index),
                    )
                  }
                  aria-label={`Remove ${name} from this List`}
                  title="Remove from this List"
                  className={cn(
                    ICON_BUTTON,
                    "hover:bg-red-50 hover:text-red-600",
                  )}
                >
                  <X className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2">
        {controls.others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={picker}
              disabled={room <= 0}
              className="inline-flex h-9 w-full items-center gap-2 rounded-full bg-black/5 px-3.5 text-sm font-semibold transition-[background-color,scale] duration-150 outline-none hover:bg-black/10 focus-visible:ring-[3px] focus-visible:ring-brand/50 active:scale-[0.98] disabled:opacity-50 data-[state=open]:bg-black/10 sm:w-auto"
            >
              <Merge className="size-4" />
              <span className="truncate">
                {room <= 0
                  ? `At most ${MAX_SOURCES_PER_LIST} Source lists`
                  : "Merge another List into this one"}
              </span>
              <ChevronDown className="ml-auto size-4 text-black/50 sm:ml-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
            >
              {controls.others.map((other) => {
                const count = listSources(other).length;
                return (
                  <DropdownMenuItem
                    key={other.localId}
                    disabled={count > room}
                    onSelect={() =>
                      changeSources(() =>
                        controls.onMerge(list.localId, other.localId),
                      )
                    }
                  >
                    <ProviderMark
                      provider={other.provider}
                      className="size-5"
                    />
                    <span className="truncate">{rowTitle(other)}</span>
                    {count > 1 && (
                      <span className="ml-auto text-xs text-black/45 tabular-nums">
                        {count} Source lists
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <p
          className={cn(
            "text-xs text-pretty text-black/50",
            controls.others.length > 0 && "mt-1",
          )}
        >
          {controls.others.length === 0 &&
            "Add another List, then merge it here to show both in one catalog. "}
          Titles that are in more than one Source list show once.
        </p>
      </div>

      {(undated.length > 0 || showHint) && (
        <ul className="mt-2 space-y-1 text-xs text-pretty text-black/60">
          {undated.length > 0 && (
            <li>
              Date added sorting is off:{" "}
              {sourcesWithVerb(undated, "does", "do")} not give the date when
              each Title was added.
            </li>
          )}
          {showHint && <li>{showHint}</li>}
        </ul>
      )}
    </div>
  );
}
