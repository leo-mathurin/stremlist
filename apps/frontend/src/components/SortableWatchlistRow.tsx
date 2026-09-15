import {
  SORT_OPTIONS,
  DISPLAY_MODE_OPTIONS,
  IMDB_WATCHLIST_SOURCE_ID_EXTRACT_PATTERN,
} from "@stremlist/shared/constants";
import { CHART_REGISTRY, CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import { Trash2, GripVertical, ExternalLink, Sparkles } from "lucide-react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { WatchlistFormRow } from "../lib/watchlist-form";
import CatalogFilterSettings from "./CatalogFilterSettings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function extractImdbSourceId(text: string): string {
  if (!text) return "";
  const match = text.match(IMDB_WATCHLIST_SOURCE_ID_EXTRACT_PATTERN);
  return match ? match[0] : "";
}

export default function SortableWatchlistRow({
  watchlist,
  index,
  onFieldChange,
  onRemove,
  canRemove,
}: {
  watchlist: WatchlistFormRow;
  index: number;
  onFieldChange: <K extends keyof WatchlistFormRow>(
    localId: string,
    key: K,
    value: WatchlistFormRow[K],
  ) => void;
  onRemove: (localId: string) => void;
  canRemove: boolean;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: watchlist.localId,
    index,
  });

  const chartEntry = CHART_BY_ID.get(watchlist.imdbUserId);
  const isChart = !!chartEntry;

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-gray-200 bg-gray-50 p-4",
        isDragSource && "opacity-50 shadow-lg ring-2 ring-imdb/30",
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            ref={handleRef}
            type="button"
            className="touch-none cursor-grab text-gray-400 hover:text-gray-600"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-4" />
          </button>
          <p className="text-sm font-semibold text-gray-800">
            Catalog {index + 1}
          </p>
          {isChart && (
            <span className="inline-flex items-center gap-1 rounded-full bg-imdb/15 px-2 py-0.5 text-[11px] font-semibold text-imdb-dark">
              <Sparkles className="size-3" />
              Built-in
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onRemove(watchlist.localId)}
          disabled={!canRemove}
          className="text-gray-500 hover:text-red-600"
          aria-label="Remove catalog"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <Label className="block text-xs font-semibold text-gray-600 mb-1">
        {isChart ? "Built-in Catalog" : "IMDb Watchlist or List"}
      </Label>
      {isChart ? (
        <>
          <Select
            value={watchlist.imdbUserId}
            onValueChange={(value) => {
              onFieldChange(watchlist.localId, "imdbUserId", value);
              // The "Show" toggle is hidden for charts, so keep displayMode in
              // lockstep with the chosen chart's (single) type — otherwise
              // switching a movie chart to a TV one would leave an empty catalog.
              const nextEntry = CHART_BY_ID.get(value);
              if (nextEntry) {
                onFieldChange(
                  watchlist.localId,
                  "displayMode",
                  nextEntry.defaultDisplayMode,
                );
              }
            }}
          >
            <SelectTrigger className="w-full bg-white focus:ring-imdb focus:border-imdb">
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
          <div className="mt-2 flex items-start justify-between gap-3">
            <p className="text-xs text-gray-500">{chartEntry.description}</p>
            <a
              href={chartEntry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-stremlist hover:underline"
            >
              View on IMDb
              <ExternalLink className="size-3" />
            </a>
          </div>
        </>
      ) : (
        <Input
          value={watchlist.imdbUserId}
          onChange={(e) => {
            const extracted = extractImdbSourceId(e.target.value);
            onFieldChange(
              watchlist.localId,
              "imdbUserId",
              extracted || e.target.value,
            );
          }}
          placeholder="ur12345678, p.colneedham, or ls593621567"
          className="focus-visible:ring-imdb focus-visible:border-imdb"
        />
      )}

      <Label className="block text-xs font-semibold text-gray-600 mt-3 mb-1">
        Catalog Title (Optional)
      </Label>
      <Input
        value={watchlist.catalogTitle}
        onChange={(e) =>
          onFieldChange(watchlist.localId, "catalogTitle", e.target.value)
        }
        placeholder="Tom Hardy's Watchlist"
        className="focus-visible:ring-imdb focus-visible:border-imdb"
      />

      <Label className="block text-xs font-semibold text-gray-600 mt-3 mb-1">
        Sort Order
      </Label>
      <Select
        value={watchlist.sortOption}
        onValueChange={(value) =>
          onFieldChange(watchlist.localId, "sortOption", value)
        }
      >
        <SelectTrigger className="w-full bg-white focus:ring-imdb focus:border-imdb">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Built-in charts are single-type (their registry defaultDisplayMode is
          locked to movie or series), so the movies/TV "Show" toggle is
          meaningless here — exposing it only lets a user pick the empty type
          (e.g. "TV shows only" on Top 250 Movies). Hide it for chart rows. */}
      {!isChart && (
        <>
          <Label className="block text-xs font-semibold text-gray-600 mt-3 mb-1">
            Show
          </Label>
          <Select
            value={watchlist.displayMode}
            onValueChange={(value) =>
              onFieldChange(watchlist.localId, "displayMode", value)
            }
          >
            <SelectTrigger className="w-full bg-white focus:ring-imdb focus:border-imdb">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPLAY_MODE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <CatalogFilterSettings
        value={watchlist.catalogSettings}
        genres={watchlist.availableGenres}
        onChange={(settings) =>
          onFieldChange(watchlist.localId, "catalogSettings", settings)
        }
      />
    </div>
  );
}
