import { useId, useState } from "react";
import {
  SORT_OPTIONS,
  DISPLAY_MODE_OPTIONS,
} from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import {
  CHART_BY_ID,
  CHART_REGISTRY,
  imdbChartOf,
} from "@stremlist/shared/imdb-charts";
import {
  allowedDisplayModes,
  isMergedList,
  isSortAllowed,
  listSources,
} from "@stremlist/shared/list-merge";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  ChevronDown,
  ExternalLink,
  Eye,
  GripVertical,
  Settings2,
  X,
} from "lucide-react";
import { useSortable } from "@dnd-kit/react/sortable";
import { MAX_CATALOG_TITLE_LENGTH, rowTitle } from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { describeSource } from "../lib/list-sources";
import { attentionTone } from "../lib/list-sync";
import type { ListSyncState } from "../lib/list-sync";
import CatalogFilterSettings from "./CatalogFilterSettings";
import MergedSources from "./MergedSources";
import type { MergeControls } from "./MergedSources";
import CatalogPreview from "./CatalogPreview";
import { ListSyncLine, ListSyncNotice } from "./ListSyncStatus";
import { ProviderMark } from "./brand";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const FIELD_FOCUS = "focus-visible:ring-brand/50 focus-visible:border-brand";
const SELECT_FOCUS = "focus:ring-brand/50 focus:border-brand";

/** One List of the configure page: summary row, then its settings. */
export default function SortableListRow({
  list,
  index,
  accountKey,
  connectionKey,
  onFieldChange,
  onRemove,
  missingProviders,
  sync,
  saved,
  onConnect,
  merge,
}: {
  list: ListFormRow;
  index: number;
  /** Providers whose Connection the List reads through and the Account lacks. */
  missingProviders: ProviderId[];
  /** Merging other Lists into this one; absent where Lists cannot change. */
  merge?: MergeControls;
  /** Lets the preview read through the Account's Connections. */
  accountKey: string | null;
  /**
   * Identifies the Account's Connections to the Providers of the List's
   * Source lists, or "".
   */
  connectionKey: string;
  /** Its refreshes, or null on a new setup that has nothing saved yet. */
  sync: ListSyncState | null;
  /** Saved with its current Source lists. */
  saved: boolean;
  /**
   * Start the Connection again that the List's sync status asks for;
   * absent when it cannot be started here.
   */
  onConnect?: () => void;
  onFieldChange: <K extends keyof ListFormRow>(
    localId: string,
    key: K,
    value: ListFormRow[K],
  ) => void;
  onRemove: (localId: string) => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: list.localId,
    index,
  });
  const [open, setOpen] = useState(false);
  // A List added in this visit opens its preview, so the user sees what it
  // adds to Stremio before saving.
  const [previewOpen, setPreviewOpen] = useState(!list.id);
  const panelId = useId();
  const previewId = useId();
  const titleId = useId();
  const sortId = useId();
  const showId = useId();
  const chartId = useId();

  const source = describeSource(list.provider, list.sourceRef);
  const merged = isMergedList(list);
  const sources = listSources(list);
  // A merged List shows its own settings, not the chart picker of its first
  // Source list.
  const chartEntry = merged ? undefined : imdbChartOf(list);
  const isChart = !!chartEntry;
  const title = rowTitle(list);
  const displayModes = allowedDisplayModes(list);
  const providers = [...new Set(sources.map((item) => item.provider))];
  const providerLabels = providers
    .map((provider) => PROVIDERS[provider].label)
    .join(", ");

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-3xl bg-white ring-1 ring-black/5 transition-shadow",
        attentionTone(sync) === "warn" && "ring-amber-300",
        attentionTone(sync) === "bad" && "ring-red-200",
        isDragSource && "opacity-60 shadow-lg ring-2 ring-brand/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:flex-nowrap sm:gap-4 sm:p-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <button
            ref={handleRef}
            type="button"
            className="-ml-1 flex h-10 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-black/30 transition-colors hover:text-black/70 active:cursor-grabbing"
            aria-label={`Drag to reorder ${title}`}
          >
            <GripVertical className="size-4" />
          </button>
          {merged ? (
            <span
              className="relative flex shrink-0 items-center"
              title={`${sources.length} Source lists`}
            >
              {providers.slice(0, 3).map((provider, position) => (
                <ProviderMark
                  key={provider}
                  provider={provider}
                  className={cn("ring-2 ring-white", position > 0 && "-ml-3")}
                />
              ))}
              <span className="absolute -right-1.5 -bottom-1 min-w-4.5 rounded-full bg-ink px-1 text-center text-[10px] leading-4.5 font-bold text-cloud tabular-nums ring-2 ring-white">
                {sources.length}
              </span>
            </span>
          ) : (
            <ProviderMark provider={list.provider} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold leading-tight">{title}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-black/50">
              <span className="truncate tabular-nums">
                {merged ? (
                  `${sources.length} Source lists · ${providerLabels}`
                ) : (
                  <>
                    {PROVIDERS[list.provider].label} · {source.kindLabel}
                    {source.detail ? ` · ${source.detail}` : ""}
                  </>
                )}
              </span>
              {!merged && source.url && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open on ${PROVIDERS[list.provider].label}`}
                  title={`Open on ${PROVIDERS[list.provider].label}`}
                  className="shrink-0 rounded p-0.5 text-black/40 transition-colors hover:text-stremlist"
                >
                  <ExternalLink className="size-3" />
                </a>
              )}
            </p>
          </div>
        </div>

        <div className="flex w-full items-center gap-2 pl-9 sm:w-auto sm:pl-0">
          <Label htmlFor={sortId} className="sr-only">
            Sort order
          </Label>
          <Select
            value={list.sortOption}
            onValueChange={(value) =>
              onFieldChange(list.localId, "sortOption", value)
            }
          >
            <SelectTrigger
              id={sortId}
              size="sm"
              className={cn(
                "min-w-0 flex-1 rounded-full border-0 bg-black/5 shadow-none sm:w-60 sm:flex-none",
                SELECT_FOCUS,
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  // Explained under Source lists, in the settings.
                  disabled={!isSortAllowed(list, opt.value)}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-expanded={previewOpen}
                aria-controls={previewId}
                aria-label={`Preview ${title}`}
                onClick={() => setPreviewOpen((current) => !current)}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96]",
                  previewOpen
                    ? "bg-ink text-cloud"
                    : "bg-black/5 hover:bg-black/10",
                )}
              >
                <Eye className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>Preview</TooltipContent>
          </Tooltip>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`Settings for ${title}`}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold transition-colors",
              open ? "bg-ink text-cloud" : "bg-black/5 hover:bg-black/10",
            )}
          >
            <Settings2 className="size-3.5" />
            <span className="hidden sm:inline">Settings</span>
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200 ease-out-quint",
                open && "rotate-180",
              )}
            />
          </button>
          <button
            type="button"
            aria-label={`Remove ${title}`}
            onClick={() => onRemove(list.localId)}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-black/35 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {sync && (
        <>
          {/* Under the name column, but as wide as the row, so the status
              never truncates behind the sort control. */}
          <div className="-mt-2 flex gap-3 px-3 pb-3 sm:-mt-3 sm:gap-4 sm:px-4 sm:pb-4">
            <span aria-hidden="true" className="-ml-1 w-6 shrink-0" />
            <span aria-hidden="true" className="w-8 shrink-0" />
            <ListSyncLine sync={sync} saved={saved} />
          </div>
          <ListSyncNotice
            title={title}
            provider={list.provider}
            sourceRef={list.sourceRef}
            sync={sync}
            onConnect={onConnect}
          />
        </>
      )}

      <div
        id={panelId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] ease-out-quint motion-reduce:transition-none",
          open
            ? "grid-rows-[1fr] duration-250"
            : "grid-rows-[0fr] duration-200",
        )}
      >
        <div className="-mx-1 min-h-0 overflow-hidden px-1">
          <div className="border-t border-black/5 px-4 pt-4 pb-4 sm:px-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {isChart && (
                <div className="sm:col-span-2">
                  <Label
                    htmlFor={chartId}
                    className="mb-1 block text-xs font-semibold text-black/60"
                  >
                    Built-in chart
                  </Label>
                  <Select
                    value={list.sourceRef}
                    onValueChange={(value) => {
                      onFieldChange(list.localId, "sourceRef", value);
                      // Charts have one Title type, so the display mode
                      // follows the chart; otherwise a TV chart could keep
                      // "Movies only" and show an empty catalog.
                      const next = CHART_BY_ID.get(value);
                      if (next) {
                        onFieldChange(
                          list.localId,
                          "displayMode",
                          next.defaultDisplayMode,
                        );
                      }
                    }}
                  >
                    <SelectTrigger
                      id={chartId}
                      className={cn("w-full bg-white", SELECT_FOCUS)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHART_REGISTRY.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-black/50">
                    {chartEntry.description}
                  </p>
                </div>
              )}

              <div className={cn(isChart && "sm:col-span-2")}>
                <Label
                  htmlFor={titleId}
                  className="mb-1 block text-xs font-semibold text-black/60"
                >
                  Catalog title
                </Label>
                <Input
                  id={titleId}
                  value={list.catalogTitle}
                  maxLength={MAX_CATALOG_TITLE_LENGTH}
                  onChange={(e) =>
                    onFieldChange(list.localId, "catalogTitle", e.target.value)
                  }
                  placeholder={source.suggestedTitle}
                  className={cn("bg-white", FIELD_FOCUS)}
                />
              </div>

              {/* Charts have a single Title type, so "Show" would only offer
                  an empty choice there. */}
              {!isChart && (
                <div>
                  <Label
                    htmlFor={showId}
                    className="mb-1 block text-xs font-semibold text-black/60"
                  >
                    Show
                  </Label>
                  <Select
                    value={list.displayMode}
                    onValueChange={(value) =>
                      onFieldChange(
                        list.localId,
                        "displayMode",
                        value as DisplayMode,
                      )
                    }
                  >
                    <SelectTrigger
                      id={showId}
                      className={cn("w-full bg-white", SELECT_FOCUS)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DISPLAY_MODE_OPTIONS.map((opt) => (
                        <SelectItem
                          key={opt.value}
                          value={opt.value}
                          disabled={!displayModes.includes(opt.value)}
                        >
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {merge && (
              <MergedSources
                list={list}
                missingProviders={missingProviders}
                controls={merge}
              />
            )}

            <CatalogFilterSettings
              value={list.catalogSettings}
              genres={list.availableGenres}
              onChange={(settings) =>
                onFieldChange(list.localId, "catalogSettings", settings)
              }
            />
          </div>
        </div>
      </div>

      <div
        id={previewId}
        inert={!previewOpen}
        className={cn(
          "grid transition-[grid-template-rows] ease-out-quint motion-reduce:transition-none",
          previewOpen
            ? "grid-rows-[1fr] duration-250"
            : "grid-rows-[0fr] duration-200",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <CatalogPreview
            list={list}
            accountKey={accountKey}
            connectionKey={connectionKey}
            open={previewOpen}
          />
        </div>
      </div>
    </div>
  );
}
