import { useId, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  CATALOG_DECADES,
  CATALOG_PRESETS,
} from "@stremlist/shared/catalog-settings";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Radix Select reserves "" for "nothing selected", so the "any" option needs
// a real value of its own.
const ANY = "__any__";

type FilterKey = "genre" | "decade" | "maxRuntime" | "minRating";

type Filter = {
  key: FilterKey;
  label: string;
  empty: string;
  choices: readonly (string | number)[];
  suffix: string;
};

const NUMERIC_FILTERS: readonly Filter[] = [
  {
    key: "decade",
    label: "Decade",
    empty: "All decades",
    choices: CATALOG_DECADES.map((decade) => Number.parseInt(decade, 10)),
    suffix: "s",
  },
  {
    key: "maxRuntime",
    label: "Maximum runtime",
    empty: "Any length",
    choices: [60, 90, 120, 150, 180],
    suffix: " min or less",
  },
  {
    key: "minRating",
    label: "Minimum IMDb rating",
    empty: "Any rating",
    choices: [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9],
    suffix: " and above",
  },
];

const FILTER_KEYS: readonly FilterKey[] = [
  "genre",
  "decade",
  "maxRuntime",
  "minRating",
];

export default function CatalogFilterSettings({
  value,
  genres,
  onChange,
}: {
  value: CatalogSettings;
  genres: string[];
  onChange: (settings: CatalogSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const filters: readonly Filter[] = [
    {
      key: "genre",
      label: "Genre",
      empty: "All genres",
      choices: genres,
      suffix: "",
    },
    ...NUMERIC_FILTERS,
  ];
  const activeFilters = FILTER_KEYS.filter(
    (key) => value[key] !== undefined,
  ).length;
  const activeCount = activeFilters + (value.presets?.length ?? 0);
  const genreLocked = genres.length === 0 && value.genre === undefined;

  return (
    <div className="mt-4 border-t border-gray-200 pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-gray-200/50 focus-visible:ring-[3px] focus-visible:ring-imdb/40"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white text-gray-500 shadow-xs ring-1 ring-gray-200/80 transition-colors duration-150 group-hover:text-gray-800">
          <SlidersHorizontal className="size-3.5" />
        </span>
        <span className="text-sm font-semibold text-gray-800">
          Filters &amp; extra catalogs
        </span>
        {activeCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-imdb/15 px-2 py-0.5 text-[11px] font-semibold text-imdb-dark tabular-nums transition-[opacity,scale] duration-150 ease-out starting:scale-90 starting:opacity-0 motion-reduce:transition-none">
            {activeCount} active
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-gray-400 transition-transform duration-200 ease-out-quint group-hover:text-gray-600 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Height reveal via grid-template-rows so the transition stays
          interruptible and needs no measurement. Inner wrapper bleeds 4px on
          each side so focus rings aren't clipped by overflow-hidden. */}
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
          <div
            className={cn(
              "pt-2 pb-1 transition-[opacity,translate] ease-out-quint motion-reduce:transition-none",
              open
                ? "translate-y-0 opacity-100 delay-50 duration-250"
                : "-translate-y-1 opacity-0 duration-150",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs leading-relaxed text-pretty text-gray-500">
                All selected filters apply together, including in search. Use
                Sort Order above to order the results.
              </p>
              {activeFilters > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ presets: value.presets })}
                  className="-mt-1 -mr-2 h-7 shrink-0 px-2 text-xs text-gray-500 hover:text-gray-900"
                >
                  Clear filters
                </Button>
              )}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {filters.map((filter) => {
                const current = value[filter.key];
                const options = new Set<string | number>(filter.choices);
                if (current !== undefined) options.add(current);
                const triggerId = `${panelId}-${filter.key}`;
                return (
                  <div key={filter.key} className="min-w-0">
                    <Label
                      htmlFor={triggerId}
                      className="mb-1 text-xs font-semibold text-gray-600"
                    >
                      {filter.label}
                    </Label>
                    <Select
                      value={current === undefined ? ANY : String(current)}
                      disabled={filter.key === "genre" && genreLocked}
                      onValueChange={(next) =>
                        onChange({
                          ...value,
                          [filter.key]:
                            next === ANY
                              ? undefined
                              : filter.key === "genre"
                                ? next
                                : Number(next),
                        })
                      }
                    >
                      <SelectTrigger
                        id={triggerId}
                        className="w-full bg-white focus:border-imdb focus:ring-imdb data-[state=open]:border-imdb"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>{filter.empty}</SelectItem>
                        {[...options].map((option) => (
                          <SelectItem key={option} value={String(option)}>
                            {option}
                            {filter.suffix}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {filter.key === "genre" && genres.length === 0 && (
                      <p className="mt-1 text-[11px] leading-snug text-gray-500">
                        Genre choices appear after saving and refreshing this
                        list.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4">
              <p className="text-xs font-semibold text-gray-600">
                Extra catalogs on your Stremio home
              </p>
              <p className="mt-0.5 text-xs text-pretty text-gray-500">
                Use the same list and filters. Reinstall after changing these
                options.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {CATALOG_PRESETS.map((preset) => {
                  const checked = value.presets?.includes(preset.id) ?? false;
                  return (
                    <label
                      key={preset.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm select-none transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100",
                        checked
                          ? "border-imdb bg-imdb/10 text-gray-900"
                          : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          onChange({
                            ...value,
                            presets: next
                              ? [...(value.presets ?? []), preset.id]
                              : value.presets?.filter((id) => id !== preset.id),
                          })
                        }
                        className="focus-visible:border-imdb focus-visible:ring-imdb/40 data-checked:border-imdb data-checked:bg-imdb data-checked:text-black"
                      />
                      {preset.label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
