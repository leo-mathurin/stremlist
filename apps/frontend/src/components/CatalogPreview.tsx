import { memo, useEffect, useId, useRef, useState } from "react";
import { Clapperboard, ExternalLink, Loader2, RotateCw, X } from "lucide-react";
import { CATALOG_TITLES_PAGE_SIZE } from "@stremlist/shared/catalog-preview";
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
import type { DisplayMode, TitleType } from "@stremlist/shared/constants";
import { isMergedList, listSources } from "@stremlist/shared/list-merge";
import { joinProviderLabels } from "@stremlist/shared/providers";
import type { SourceId } from "@stremlist/shared/providers";
import { choosePoster } from "@stremlist/shared/poster";
import type { PosterSource } from "@stremlist/shared/poster";
import {
  sourceProblemCopy,
  storedSourceNoun,
} from "@stremlist/shared/source-problems";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { useCatalogPreview } from "@/hooks/useCatalogPreview";
import { useCatalogTitles } from "@/hooks/useCatalogTitles";
import { useNow } from "@/hooks/useNow";
import { rowTitle } from "@/lib/list-form";
import type { ListFormRow } from "@/lib/list-form";
import { previewQueueMessage, queueProgress } from "@/lib/provider-queue";
import type { QueueWait } from "@/lib/provider-queue";
import { cn } from "@/lib/utils";

const UNRESOLVED_COLLAPSED = 5;
const DIALOG_CHUNK = 60;

const TYPE_LABELS = { movie: "Movies", series: "TV shows" } as const;
const TYPE_NOUNS = {
  movie: { one: "movie", other: "movies" },
  series: { one: "TV show", other: "TV shows" },
} as const;
const OTHER_TYPE = { movie: "series", series: "movie" } as const;

function count(value: number, one: string, other: string) {
  return `${value.toLocaleString("en")} ${value === 1 ? one : other}`;
}

function showOnlyLabel(type: TitleType) {
  const option = DISPLAY_MODE_OPTIONS.find((entry) => entry.value === type);
  if (!option) throw new Error(`No Show option for ${type}.`);
  return option.label;
}

function catalogLabel(row: CatalogPreviewRow) {
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
  rpdbApiKey,
  posterSource,
  open,
}: {
  list: ListFormRow;
  accountKey: string | null;
  rpdbApiKey: string;
  posterSource: PosterSource;
  /** The panel is visible: only then the preview is read. */
  open: boolean;
}) {
  const { state, retry } = useCatalogPreview({
    list,
    accountKey,
    enabled: open,
  });
  const [allTitlesOf, setAllTitlesOf] = useState<CatalogPreviewRow | null>(
    null,
  );

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
        <PreviewLoading list={list} />
      ) : state.status === "queued" ? (
        <PreviewQueued wait={state.wait} />
      ) : state.status === "problem" ? (
        <PreviewMessage
          tone={state.reason === "unavailable" ? "error" : "info"}
          onRetry={state.reason === "unavailable" ? retry : undefined}
        >
          {problemMessage(state.source ?? list, state.reason)}
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
            rpdbApiKey={rpdbApiKey}
            posterSource={posterSource}
            onShowAll={state.updating ? null : setAllTitlesOf}
          />
        </div>
      )}

      {allTitlesOf && (
        <CatalogTitlesDialog
          list={list}
          accountKey={accountKey}
          row={allTitlesOf}
          rpdbApiKey={rpdbApiKey}
          posterSource={posterSource}
          onClose={() => setAllTitlesOf(null)}
        />
      )}
    </div>
  );
}

function problemMessage(source: SourceId, reason: SourceProblemReason) {
  const { title, fix } = sourceProblemCopy(
    source.provider,
    reason,
    storedSourceNoun(source.provider, source.sourceRef),
    source.sourceRef,
  );
  return `${title}. ${fix}`;
}

function PreviewLoading({ list }: { list: ListFormRow }) {
  const on = joinProviderLabels([
    ...new Set(listSources(list).map((source) => source.provider)),
  ]);
  return (
    <div className="space-y-2" role="status">
      <p className="flex items-center gap-2 text-xs text-black/50">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {isMergedList(list)
          ? `Reading the merged lists on ${on}. Big lists can take a few seconds.`
          : `Reading the list on ${on}. A big list can take a few seconds.`}
      </p>
      <PosterPlaceholders />
    </div>
  );
}

function PosterPlaceholders() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="w-[4.5rem] shrink-0 sm:w-20">
          <div className="aspect-[2/3] animate-pulse rounded-xl bg-black/5 motion-reduce:animate-none" />
          <div className="mt-1.5 h-2.5 w-4/5 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

function PreviewQueued({ wait }: { wait: QueueWait }) {
  const now = useNow();
  const progress = Math.round(queueProgress(wait, now) * 100);
  return (
    <div className="space-y-2" role="status">
      <p className="text-xs text-pretty text-black/50 tabular-nums">
        {previewQueueMessage(wait, now)}
      </p>
      <div
        role="progressbar"
        aria-label="Place in the queue"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="h-1.5 overflow-hidden rounded-full bg-black/5"
      >
        <div
          className="h-full origin-left rounded-full bg-brand transition-transform duration-1000 ease-linear motion-reduce:transition-none"
          style={{ transform: `scaleX(${progress / 100})` }}
        />
      </div>
      <PosterPlaceholders />
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
  rpdbApiKey,
  posterSource,
  onShowAll,
}: {
  preview: CatalogPreviewData;
  displayMode: DisplayMode;
  settings: CatalogSettings;
  rpdbApiKey: string;
  posterSource: PosterSource;
  onShowAll: ((row: CatalogPreviewRow) => void) | null;
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
          rpdbApiKey={rpdbApiKey}
          posterSource={posterSource}
          onShowAll={onShowAll && (() => onShowAll(row))}
        />
      ))}

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

      {preview.sourceProblems?.map((problem) => (
        <PreviewMessage
          key={`${problem.provider}:${problem.sourceRef}`}
          tone={problem.reason === "unavailable" ? "error" : "info"}
        >
          {`${problemMessage(problem, problem.reason)} Its titles are not in this catalog.`}
        </PreviewMessage>
      ))}

      {preview.unresolved.count > 0 && (
        <UnresolvedEntries unresolved={preview.unresolved} />
      )}

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
  rpdbApiKey,
  posterSource,
  onShowAll,
}: {
  row: CatalogPreviewRow;
  typeCounts: CatalogPreviewData["typeCounts"];
  filtered: boolean;
  rpdbApiKey: string;
  posterSource: PosterSource;
  onShowAll: (() => void) | null;
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
        <ul
          key={row.titles.map((title) => title.id).join(",")}
          className="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:-mx-5 sm:scroll-px-5 sm:px-5"
        >
          {row.titles.map((title) => {
            const candidates = posterCandidates(title, {
              posterSource,
              rpdbApiKey,
            });
            return (
              <li key={title.id} className="snap-start">
                <PosterTile
                  key={candidates.join(" ")}
                  title={title}
                  posters={candidates}
                />
              </li>
            );
          })}
          {more > 0 && (
            <li className="snap-start">
              <button
                type="button"
                onClick={onShowAll ?? undefined}
                disabled={!onShowAll}
                aria-haspopup="dialog"
                aria-label={`Show all ${count(row.total, nouns.one, nouns.other)} of this catalog`}
                className="flex aspect-[2/3] w-[4.5rem] shrink-0 flex-col items-center justify-center rounded-xl bg-black/5 text-center outline-none ring-brand/60 transition-[background-color,scale] duration-150 ease-out focus-visible:ring-2 enabled:cursor-pointer enabled:hover:bg-black/10 enabled:active:scale-[0.96] sm:w-20"
              >
                <span className="text-sm font-bold tabular-nums">
                  +{more.toLocaleString("en")}
                </span>
                <span className="text-[11px] text-black/50">more</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function posterCandidates(
  title: PreviewTitle,
  {
    posterSource,
    rpdbApiKey,
  }: { posterSource: PosterSource; rpdbApiKey: string },
) {
  const posters = {
    imdb: title.poster,
    tmdb: title.tmdbPoster,
    tvdb: title.tvdbPoster,
  };
  return [
    ...new Set([
      choosePoster(title.id, posters, { posterSource, rpdbApiKey }),
      choosePoster(title.id, posters, { posterSource }),
      title.poster,
    ]),
  ].filter((poster): poster is string => poster !== null);
}

function PosterTile({
  title,
  posters,
  fill = false,
}: {
  title: PreviewTitle;
  posters: string[];
  fill?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const poster = posters.at(attempt) ?? null;
  const [loaded, setLoaded] = useState(false);
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
      className={cn(
        "group block shrink-0 rounded-xl outline-none",
        fill ? "w-full" : "w-[4.5rem] sm:w-20",
      )}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-black/5 ring-brand/60 transition-shadow duration-150 group-focus-visible:ring-2">
        {poster ? (
          <img
            key={poster}
            src={poster}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setLoaded(false);
              setAttempt((current) => current + 1);
            }}
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

function CatalogTitlesDialog({
  list,
  accountKey,
  row,
  rpdbApiKey,
  posterSource,
  onClose,
}: {
  list: ListFormRow;
  accountKey: string | null;
  row: CatalogPreviewRow;
  rpdbApiKey: string;
  posterSource: PosterSource;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { titles, total, status, hasMore, loadMore } = useCatalogTitles({
    list,
    accountKey,
    row,
  });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    const onClick = (event: MouseEvent) => {
      if (event.target === element) element.close();
    };
    element.addEventListener("click", onClick);
    return () => element.removeEventListener("click", onClick);
  }, []);

  const placeholders =
    status === "loading"
      ? Math.max(0, Math.min(CATALOG_TITLES_PAGE_SIZE, total - titles.length))
      : 0;
  const shown = titles.length + placeholders;

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || status !== "idle") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: scroller.current, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, status, loadMore]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className={
        "m-auto max-h-[min(48rem,calc(100dvh-2rem))] open:flex w-[calc(100%-2rem)] max-w-3xl flex-col overflow-hidden rounded-3xl bg-white p-0 font-rounded text-ink shadow-xl ring-1 ring-black/5 " +
        "transition-[opacity,scale] duration-200 ease-out-quint starting:scale-[0.96] starting:opacity-0 motion-reduce:starting:scale-100 " +
        "backdrop:bg-black/40 backdrop:transition-opacity backdrop:duration-200 starting:backdrop:opacity-0"
      }
    >
      <div className="flex items-start justify-between gap-3 border-b border-black/5 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-base font-bold">
            {rowTitle(list)}
          </h2>
          <p className="text-xs text-black/50 tabular-nums">
            {catalogLabel(row)} · {count(total, "title", "titles")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => dialog.current?.close()}
          aria-label="Close"
          className="-mr-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-black/50 transition-[background-color,color,scale] duration-150 ease-out hover:bg-black/5 hover:text-ink active:scale-[0.96]"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
      >
        <div className="flex flex-col gap-4">
          {Array.from(
            { length: Math.ceil(shown / DIALOG_CHUNK) },
            (_, chunk) => (
              <ul
                key={chunk}
                className="-m-0.5 grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-x-3 gap-y-4 [contain-intrinsic-block-size:auto_130rem] p-0.5 [content-visibility:auto] sm:grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))]"
              >
                {titles
                  .slice(chunk * DIALOG_CHUNK, (chunk + 1) * DIALOG_CHUNK)
                  .map((title) => (
                    <DialogTile
                      key={title.id}
                      title={title}
                      posterSource={posterSource}
                      rpdbApiKey={rpdbApiKey}
                    />
                  ))}
                {Array.from(
                  {
                    length: Math.max(
                      0,
                      Math.min(shown, (chunk + 1) * DIALOG_CHUNK) -
                        Math.max(titles.length, chunk * DIALOG_CHUNK),
                    ),
                  },
                  (_, index) => (
                    <DialogTilePlaceholder key={`placeholder-${index}`} />
                  ),
                )}
              </ul>
            ),
          )}
        </div>
        <div ref={sentinel} aria-live="polite" className="pt-4">
          {status === "loading" && (
            <p role="status" className="sr-only">
              Loading more titles
            </p>
          )}
          {status === "error" && (
            <PreviewMessage tone="error" onRetry={loadMore}>
              Could not load more titles. Check your connection and try again.
            </PreviewMessage>
          )}
        </div>
      </div>
    </dialog>
  );
}

const DialogTile = memo(function DialogTile({
  title,
  posterSource,
  rpdbApiKey,
}: {
  title: PreviewTitle;
  posterSource: PosterSource;
  rpdbApiKey: string;
}) {
  const candidates = posterCandidates(title, { posterSource, rpdbApiKey });
  return (
    <li>
      <PosterTile
        key={candidates.join(" ")}
        title={title}
        posters={candidates}
        fill
      />
    </li>
  );
});

function DialogTilePlaceholder() {
  return (
    <li aria-hidden="true">
      <div className="aspect-[2/3] animate-pulse rounded-xl bg-black/5 motion-reduce:animate-none" />
      <div className="mt-1.5 h-2.5 w-4/5 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
    </li>
  );
}

function UnresolvedEntries({
  unresolved,
}: {
  unresolved: CatalogPreviewData["unresolved"];
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const shown = expanded
    ? unresolved.entries
    : unresolved.entries.slice(0, UNRESOLVED_COLLAPSED);
  const notListed = unresolved.count - unresolved.entries.length;

  return (
    <section className="space-y-2 rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
      <div>
        <h4 className="flex items-baseline gap-2 text-sm font-bold text-amber-950">
          Titles not found
          <span className="text-xs font-semibold text-amber-900/70 tabular-nums">
            {unresolved.count.toLocaleString("en")}
          </span>
        </h4>
        <p className="mt-0.5 text-xs text-pretty text-amber-900/80">
          Stremlist could not match{" "}
          {unresolved.count === 1 ? "this title" : "these titles"} with IMDb
          yet, so Stremio does not show {unresolved.count === 1 ? "it" : "them"}
          . Stremlist tries again at each refresh.
          {unresolved.notCheckedYet > 0 &&
            ` ${count(unresolved.notCheckedYet, "title is", "titles are")} not checked yet.`}
        </p>
      </div>
      <ul id={listId} className="divide-y divide-amber-200/70">
        {shown.map((entry, index) => (
          <UnresolvedRow key={index} entry={entry} />
        ))}
      </ul>
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
  const name = entry.title ?? "Title without a name";
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
