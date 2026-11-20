import { useId, useState } from "react";
import { DISPLAY_MODE_OPTIONS } from "@stremlist/shared/constants";
import { NEW_TITLES_SORT_OPTIONS } from "@stremlist/shared/manifest-catalogs";
import type { PosterSource } from "@stremlist/shared/poster";
import type { SourceId } from "@stremlist/shared/providers";
import type {
  NewTitlesSettings,
  NewTitlesSummary,
} from "@stremlist/shared/stremio.types";
import { GripVertical, Sparkles } from "lucide-react";
import { useSortable } from "@dnd-kit/react/sortable";
import { useNow } from "@/hooks/useNow";
import { MAX_CATALOG_TITLE_LENGTH } from "@/lib/list-form";
import {
  NEW_TITLES_FALLBACK_TITLE,
  NEW_TITLES_ROW_ID,
  newTitlesSort,
  newTitlesTitle,
} from "@/lib/new-titles";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import CatalogFilterSettings from "./CatalogFilterSettings";
import CatalogPreview from "./CatalogPreview";
import { CatalogOrderControls, RowActions } from "./ListRowParts";

function plural(count: number, one: string, other: string) {
  return `${count.toLocaleString("en")} ${count === 1 ? one : other}`;
}

function summaryLine(summary: NewTitlesSummary | null, now: number) {
  if (!summary) return "From your other lists";
  if (summary.detected === 0) return "Nothing detected yet";
  return `${plural(summary.detected, "title", "titles")} detected, the latest ${formatRelativeTime(summary.latestDetectedAt, now)}`;
}

function SummaryLine({ summary }: { summary: NewTitlesSummary | null }) {
  return <>{summaryLine(summary, useNow())}</>;
}

/**
 * The built-in "New titles" catalog (ADR 0007), as one row among the Lists:
 * the Titles that Stremlist detects in the user's other Lists. It reorders,
 * sorts, filters and previews like a List, but it has no Source list of
 * its own, so no Provider, sync or merge controls.
 */
export default function NewTitlesRow({
  settings,
  index,
  summary,
  genres,
  sources,
  previewRevision,
  locked,
  accountKey,
  rpdbApiKey,
  posterSource,
  onFieldChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  justAdded = false,
}: {
  settings: NewTitlesSettings;
  /** Its index among all the rows, for drag and drop. */
  index: number;
  /** Null for a new setup or when the history cannot be read. */
  summary: NewTitlesSummary | null;
  /** The genres of the Lists, for the genre filter. */
  genres: string[];
  sources: SourceId[];
  previewRevision: number;
  locked: boolean;
  accountKey: string | null;
  rpdbApiKey: string;
  posterSource: PosterSource;
  onFieldChange: <K extends keyof NewTitlesSettings>(
    key: K,
    value: NewTitlesSettings[K],
  ) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Added from Quick add a moment ago: the row eases in. */
  justAdded?: boolean;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: NEW_TITLES_ROW_ID,
    index,
    disabled: locked,
  });
  const [open, setOpen] = useState(false);
  const [entering, setEntering] = useState(justAdded);
  const [previewOpen, setPreviewOpen] = useState(justAdded);
  const panelId = useId();
  const previewId = useId();
  const titleId = useId();
  const sortId = useId();
  const showId = useId();
  const title = newTitlesTitle(settings);
  const waiting = summary?.waitingLists ?? 0;

  return (
    <div
      ref={ref}
      data-list-row={NEW_TITLES_ROW_ID}
      data-testid="new-titles-row"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false);
      }}
      className={cn(
        "scroll-mt-5 rounded-3xl bg-white ring-1 ring-black/5 transition-shadow",
        entering &&
          "animate-in duration-200 ease-out-quint fade-in motion-safe:slide-in-from-top-2",
        isDragSource && "opacity-60 shadow-lg ring-2 ring-brand/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:flex-nowrap sm:gap-4 sm:p-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <button
            ref={handleRef}
            type="button"
            className="-mx-3 flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-black/30 transition-colors hover:text-black/70 active:cursor-grabbing"
            aria-label={`Drag to reorder ${title}`}
            disabled={locked}
          >
            <GripVertical className="size-4" />
          </button>
          <span
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/25 text-ink"
          >
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold leading-tight" title={title}>
              {title}
            </p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-black/50">
              <span className="shrink-0 rounded-full bg-black/5 px-1.5 text-2xs leading-4 font-semibold text-black/60">
                Built-in
              </span>
              <span className="truncate tabular-nums">
                <SummaryLine summary={summary} />
              </span>
            </p>
          </div>
        </div>

        <div className="flex w-full items-center gap-2 pl-9 sm:w-auto sm:shrink-0 sm:pl-0">
          <Label htmlFor={sortId} className="sr-only">
            Sort order
          </Label>
          <Select
            disabled={locked}
            value={settings.sortOption}
            onValueChange={(value) =>
              onFieldChange("sortOption", newTitlesSort(value))
            }
          >
            <SelectTrigger
              id={sortId}
              size="sm"
              variant="soft"
              className="min-w-0 flex-1 sm:w-56 sm:flex-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NEW_TITLES_SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <RowActions
            title={title}
            preview={{
              expanded: previewOpen,
              setExpanded: setPreviewOpen,
              controls: previewId,
            }}
            settings={{
              expanded: open,
              setExpanded: setOpen,
              controls: panelId,
            }}
            onRemove={onRemove}
            locked={locked}
          />
        </div>
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent id={panelId}>
          <fieldset
            disabled={locked}
            className="min-w-0 border-t border-black/5 px-4 pt-4 pb-4 sm:px-5"
          >
            <p className="mb-4 rounded-2xl bg-black/[0.03] px-4 py-3 text-sm text-pretty text-black/60">
              Stremlist adds a title here when it appears in one of your other
              lists. Titles that were there when Stremlist first read a list do
              not count. Dates show when Stremlist detected a title, which can
              be later than when you added it.
              {waiting > 0 &&
                ` Stremlist could not read ${plural(waiting, "list", "lists")} in full yet, so it cannot compare ${waiting === 1 ? "it" : "them"}.`}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label
                  htmlFor={titleId}
                  variant="caption"
                  className="mb-1 block"
                >
                  Catalog title
                </Label>
                <Input
                  id={titleId}
                  value={settings.catalogTitle}
                  maxLength={MAX_CATALOG_TITLE_LENGTH}
                  onChange={(event) =>
                    onFieldChange("catalogTitle", event.target.value)
                  }
                  placeholder={NEW_TITLES_FALLBACK_TITLE}
                />
              </div>
              <div>
                <Label
                  htmlFor={showId}
                  variant="caption"
                  className="mb-1 block"
                >
                  Show
                </Label>
                <Select
                  value={settings.displayMode}
                  onValueChange={(value) => {
                    const mode = DISPLAY_MODE_OPTIONS.find(
                      (option) => option.value === value,
                    )?.value;
                    if (mode) onFieldChange("displayMode", mode);
                  }}
                >
                  <SelectTrigger id={showId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DISPLAY_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <CatalogOrderControls
              title={title}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
            />

            <CatalogFilterSettings
              value={settings.catalogSettings ?? {}}
              genres={genres}
              onChange={(next) => onFieldChange("catalogSettings", next)}
              searchable={false}
            />
          </fieldset>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
        <CollapsibleContent id={previewId}>
          <CatalogPreview
            key={previewRevision}
            subject={{ kind: "new-titles", settings, sources }}
            title={title}
            accountKey={accountKey}
            rpdbApiKey={rpdbApiKey}
            posterSource={posterSource}
            open={previewOpen}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
