import { useId, useState } from "react";
import {
  CircleCheck,
  Clapperboard,
  ExternalLink,
  Loader2,
  RotateCw,
} from "lucide-react";
import type {
  CatalogPreview as CatalogPreviewData,
  CatalogPreviewRow,
  PreviewTitle,
  PreviewUnresolvedEntry,
} from "@stremlist/shared/catalog-preview";
import {
  CATALOG_PRESETS,
  countCatalogFilters,
} from "@stremlist/shared/catalog-settings";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import { DISPLAY_MODE_OPTIONS } from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import { PROVIDERS } from "@stremlist/shared/providers";
import {
  sourceProblemCopy,
  storedSourceNoun,
} from "@stremlist/shared/source-problems";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { useCatalogPreview } from "@/hooks/useCatalogPreview";
import type { ListFormRow } from "@/lib/list-form";
import { cn } from "@/lib/utils";

/** Unresolved entries shown before "Show all". */
const UNRESOLVED_COLLAPSED = 5;

type TitleType = CatalogPreviewRow["type"];

const TYPE_LABELS = { movie: "Movies", series: "TV shows" } as const;
const TYPE_NOUNS = {
  movie: { one: "movie", other: "movies" },
  series: { one: "TV show", other: "TV shows" },
} as const;
const OTHER_TYPE = { movie: "series", series: "movie" } as const;

function count(value: number, one: string, other: string): string {
  return `${value.toLocaleString("en")} ${value === 1 ? one : other}`;
}

/** The label of the Show option that keeps only `type`. */
function showOnlyLabel(type: TitleType): string {
  return DISPLAY_MODE_OPTIONS.find((option) => option.value === type)!.label;
}

function catalogLabel(row: CatalogPreviewRow): string {
  const preset = CATALOG_PRESETS.find((entry) => entry.id === row.preset);
  return preset
    ? `${TYPE_LABELS[row.type]} · ${preset.label}`
    : TYPE_LABELS[row.type];
}

/**
 * What a List adds to Stremio, before it is saved: the first Titles of each
 * Catalog, and the Unresolved entries that Stremio will not show.
 */
export default function CatalogPreview({
  list,
  accountKey,
  connectionKey,
  open,
}: {
  list: ListFormRow;
  accountKey: string | null;
  /** Identifies the Account's Connection to the List's Provider, or "". */
  connectionKey: string;
  /** The panel is visible: only then the preview is read. */
  open: boolean;
}) {
  const { state, retry } = useCatalogPreview({
    list,
    accountKey,
    connectionKey,
    enabled: open,
  });

  return (
    <div className="space-y-4 border-t border-black/5 px-4 pt-4 pb-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold">Preview</p>
          <p className="text-xs text-pretty text-black/50">
            The first titles of each catalog, in the order Stremio shows them.
          </p>
        </div>
        <p
          aria-live="polite"
          className="flex shrink-0 items-center gap-1.5 text-xs text-black/45 tabular-nums"
        >
          {state.status === "ready" && state.updating && (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          )}
          {state.status === "ready" &&
            count(state.preview.titleCount, "title", "titles")}
        </p>
      </div>

      {state.status === "loading" ? (
        <PreviewLoading label={PROVIDERS[list.provider].label} />
      ) : state.status === "problem" ? (
        <PreviewMessage
          tone={state.reason === "unavailable" ? "error" : "info"}
          onRetry={state.reason === "unavailable" ? retry : undefined}
        >
          {problemMessage(list, state.reason)}
        </PreviewMessage>
      ) : state.status === "error" ? (
        <PreviewMessage tone="error" onRetry={retry}>
          Could not load the preview. Check your connection and try again.
        </PreviewMessage>
      ) : (
        <div
          className={cn(
            "space-y-4 transition-opacity duration-150 ease-out",
            state.updating && "opacity-60",
          )}
        >
          <PreviewBody
            preview={state.preview}
            displayMode={list.displayMode}
            settings={list.catalogSettings}
          />
        </div>
      )}
    </div>
  );
}

function problemMessage(
  list: Pick<ListFormRow, "provider" | "sourceRef">,
  reason: SourceProblemReason,
): string {
  const { title, fix } = sourceProblemCopy(
    list.provider,
    reason,
    storedSourceNoun(list.provider, list.sourceRef),
  );
  return `${title}. ${fix}`;
}

function PreviewLoading({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status">
      <p className="flex items-center gap-2 text-xs text-black/50">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Reading the list on {label}. A big list can take a few seconds.
      </p>
      <div className="flex gap-3 overflow-hidden" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="w-[4.5rem] shrink-0 sm:w-20">
            <div className="aspect-[2/3] animate-pulse rounded-xl bg-black/5 motion-reduce:animate-none" />
            <div className="mt-1.5 h-2.5 w-4/5 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewMessage({
  tone,
  onRetry,
  children,
}: {
  tone: "info" | "error";
  onRetry?: () => void;
  children: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-2.5 text-sm ring-1",
        tone === "error"
          ? "bg-red-50 text-red-700 ring-red-200"
          : "bg-black/[0.03] text-black/70 ring-black/5",
      )}
    >
      <p className="min-w-0 flex-1 text-pretty">{children}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-semibold ring-1 ring-black/10 transition-[background-color,scale] duration-150 ease-out hover:bg-cloud active:scale-[0.96]"
        >
          <RotateCw className="size-3.5" aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}

function PreviewBody({
  preview,
  displayMode,
  settings,
}: {
  preview: CatalogPreviewData;
  displayMode: DisplayMode;
  settings: CatalogSettings;
}) {
  const shownType = displayMode === "split" ? null : displayMode;
  const hiddenType = shownType && OTHER_TYPE[shownType];
  const hiddenCount = hiddenType ? preview.typeCounts[hiddenType] : 0;
  const filtered = countCatalogFilters(settings) > 0;

  return (
    <>
      {preview.catalogs.map((row) => (
        <CatalogRow
          key={`${row.type}:${row.preset ?? "main"}`}
          row={row}
          typeCounts={preview.typeCounts}
          filtered={filtered}
        />
      ))}

      {/* An empty single-type Catalog already says which Show option to pick. */}
      {shownType &&
        hiddenType &&
        hiddenCount > 0 &&
        preview.typeCounts[shownType] > 0 && (
          <p className="text-xs text-pretty text-black/55">
            {count(
              hiddenCount,
              TYPE_NOUNS[hiddenType].one,
              TYPE_NOUNS[hiddenType].other,
            )}{" "}
            of this list {hiddenCount === 1 ? "does" : "do"} not show, because
            Show is set to {showOnlyLabel(shownType)}.
          </p>
        )}

      <UnresolvedEntries unresolved={preview.unresolved} />

      {preview.withoutDetails > 0 && (
        <p className="text-xs text-pretty text-black/55">
          {count(preview.withoutDetails, "title has", "titles have")} no details
          yet, so Stremio does not show{" "}
          {preview.withoutDetails === 1 ? "it" : "them"}. Stremlist tries again
          on the next refresh.
        </p>
      )}
    </>
  );
}

function CatalogRow({
  row,
  typeCounts,
  filtered,
}: {
  row: CatalogPreviewRow;
  typeCounts: CatalogPreviewData["typeCounts"];
  filtered: boolean;
}) {
  const headingId = useId();
  const more = row.total - row.titles.length;
  const nouns = TYPE_NOUNS[row.type];

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h4
        id={headingId}
        className="flex items-baseline gap-2 text-xs font-semibold text-black/60"
      >
        {catalogLabel(row)}
        <span className="font-normal text-black/45 tabular-nums">
          {count(row.total, "title", "titles")}
        </span>
      </h4>
      {row.titles.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-black/10 px-4 py-3 text-sm text-pretty text-black/55">
          {typeCounts[row.type] === 0
            ? `This list has no ${nouns.other}, so this catalog stays empty in Stremio.${
                typeCounts[OTHER_TYPE[row.type]] > 0
                  ? ` Set Show to ${showOnlyLabel(OTHER_TYPE[row.type])} in Settings to remove it.`
                  : ""
              }`
            : filtered
              ? `No ${nouns.one} of this list matches its filters, so this catalog stays empty in Stremio.`
              : "This catalog stays empty in Stremio."}
        </p>
      ) : (
        // A new order mounts a new strip: Chrome would otherwise re-snap to
        // the Title that was first and leave the strip scrolled.
        <ul
          key={row.titles.map((title) => title.id).join(",")}
          className="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:-mx-5 sm:scroll-px-5 sm:px-5"
        >
          {row.titles.map((title) => (
            <li key={title.id} className="snap-start">
              <PosterTile title={title} />
            </li>
          ))}
          {more > 0 && (
            <li className="snap-start">
              <div className="flex aspect-[2/3] w-[4.5rem] shrink-0 flex-col items-center justify-center rounded-xl bg-black/5 text-center sm:w-20">
                <span className="text-sm font-bold tabular-nums">
                  +{more.toLocaleString("en")}
                </span>
                <span className="text-[11px] text-black/50">more</span>
              </div>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function PosterTile({ title }: { title: PreviewTitle }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = title.releaseInfo
    ? `${title.name} (${title.releaseInfo})`
    : title.name;

  return (
    <a
      href={`https://www.imdb.com/title/${title.id}/`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label}, on IMDb`}
      title={label}
      className="group block w-[4.5rem] shrink-0 rounded-xl outline-none sm:w-20"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-black/5 ring-brand/60 transition-shadow duration-150 group-focus-visible:ring-2">
        {title.poster && !failed ? (
          <img
            src={title.poster}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              "size-full object-cover transition-opacity duration-200 ease-out",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        ) : (
          <span className="flex size-full items-center justify-center text-black/25">
            <Clapperboard className="size-5" aria-hidden="true" />
          </span>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-xl outline outline-1 -outline-offset-1 outline-black/10"
        />
      </div>
      <p className="mt-1.5 line-clamp-2 text-[11px] leading-tight font-semibold">
        {title.name}
      </p>
      {title.releaseInfo && (
        <p className="text-[11px] leading-tight text-black/45 tabular-nums">
          {title.releaseInfo}
        </p>
      )}
    </a>
  );
}

function UnresolvedEntries({
  unresolved,
}: {
  unresolved: CatalogPreviewData["unresolved"];
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (unresolved.count === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-black/55">
        <CircleCheck
          className="size-3.5 shrink-0 text-emerald-600"
          aria-hidden="true"
        />
        Every entry of this list has an IMDb ID, so Stremio can show them all.
      </p>
    );
  }

  const shown = expanded
    ? unresolved.entries
    : unresolved.entries.slice(0, UNRESOLVED_COLLAPSED);
  const notListed = unresolved.count - unresolved.entries.length;

  return (
    <section className="space-y-2 rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
      <div>
        <h4 className="flex items-baseline gap-2 text-sm font-bold text-amber-950">
          Unresolved entries
          <span className="text-xs font-semibold text-amber-900/70 tabular-nums">
            {unresolved.count.toLocaleString("en")}
          </span>
        </h4>
        <p className="mt-0.5 text-xs text-pretty text-amber-900/80">
          Stremlist did not find an IMDb ID for{" "}
          {unresolved.count === 1 ? "this entry" : "these entries"} yet, so
          Stremio does not show {unresolved.count === 1 ? "it" : "them"}.
          Stremlist tries again on later refreshes.
          {unresolved.notCheckedYet > 0 &&
            ` ${count(unresolved.notCheckedYet, "entry is", "entries are")} not checked yet.`}
        </p>
      </div>
      <ul id={listId} className="divide-y divide-amber-200/70">
        {shown.map((entry, index) => (
          <UnresolvedRow key={index} entry={entry} />
        ))}
      </ul>
      {/* Entries go unlisted only past the limit, so "Show all" is there. */}
      {unresolved.entries.length > UNRESOLVED_COLLAPSED && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((current) => !current)}
            className="-mx-1 rounded px-1 font-semibold text-amber-950 underline-offset-2 hover:underline"
          >
            {expanded
              ? "Show fewer"
              : `Show all ${unresolved.entries.length.toLocaleString("en")}`}
          </button>
          {expanded && notListed > 0 && (
            <span className="text-amber-900/70 tabular-nums">
              and {notListed.toLocaleString("en")} more
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function UnresolvedRow({ entry }: { entry: PreviewUnresolvedEntry }) {
  const name = entry.title ?? "Entry without a title";
  const details = [
    entry.year,
    entry.type ? (entry.type === "movie" ? "Movie" : "TV show") : null,
  ].filter((value) => value !== null);

  return (
    <li className="flex items-baseline gap-2 py-1.5 text-sm text-amber-950">
      <span className="min-w-0 flex-1 break-words text-pretty">{name}</span>
      {details.length > 0 && (
        <span className="shrink-0 text-xs text-amber-900/70 tabular-nums">
          {details.join(" · ")}
        </span>
      )}
      {entry.url && (
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${name}`}
          className="-m-1 shrink-0 self-center rounded p-1 text-amber-900/60 transition-colors hover:text-amber-950"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </li>
  );
}
