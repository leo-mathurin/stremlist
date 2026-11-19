import { useId, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  CATALOG_DECADES,
  CATALOG_PRESETS,
  countCatalogFilters,
} from "@stremlist/shared/catalog-settings";
import type {
  CatalogFilterKey,
  CatalogSettings,
} from "@stremlist/shared/catalog-settings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ANY = "__any__";

type Filter = {
  key: Exclude<CatalogFilterKey, "hideUnreleased">;
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
  const activeFilters = countCatalogFilters(value);
  const activeCount = activeFilters + (value.presets?.length ?? 0);
  const genreLocked = genres.length === 0 && value.genre === undefined;

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <div className="mt-4 border-t border-border pt-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-black/5 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white text-muted-foreground shadow-xs ring-1 ring-border/80 transition-colors duration-150 group-hover:text-ink/90">
              <SlidersHorizontal className="size-3.5" />
            </span>
            <span className="text-sm font-semibold text-ink/90">
              Filters &amp; extra catalogs
            </span>
            {activeCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-imdb/15 px-2 py-0.5 text-2xs font-semibold text-imdb-dark tabular-nums transition-[opacity,scale] duration-150 ease-out starting:scale-90 starting:opacity-0 motion-reduce:transition-none">
                {activeCount} active
              </span>
            )}
            <ChevronDown
              className={cn(
                "ml-auto size-4 shrink-0 text-black/40 transition-transform duration-200 ease-out-quint group-hover:text-black/60 motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div
            className={cn(
              "pt-2 pb-1 transition-[opacity,translate] ease-out-quint motion-reduce:transition-none",
              open
                ? "translate-y-0 opacity-100 delay-50 duration-250"
                : "-translate-y-1 opacity-0 duration-150",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs leading-relaxed text-pretty text-muted-foreground">
                All selected filters apply together, including in search. Use
                the sort menu of this list to order the results.
              </p>
              {activeFilters > 0 && (
                <Button
                  type="button"
                  variant="quiet"
                  size="xs"
                  onClick={() => onChange({ presets: value.presets })}
                  className="-mt-1 -mr-2 shrink-0"
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
                      variant="caption"
                      className="mb-1"
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
                      <SelectTrigger id={triggerId} className="w-full">
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
                      <p className="mt-1 text-2xs leading-snug text-muted-foreground">
                        Genre choices appear after saving and refreshing this
                        list.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex items-start gap-2.5">
              <Checkbox
                id={`${panelId}-unreleased`}
                aria-describedby={`${panelId}-unreleased-help`}
                checked={value.hideUnreleased === true}
                onCheckedChange={(next) =>
                  onChange({
                    ...value,
                    hideUnreleased: next === true ? true : undefined,
                  })
                }
                className="mt-0.5"
              />
              <div>
                <Label
                  htmlFor={`${panelId}-unreleased`}
                  variant="plain"
                  className="cursor-pointer"
                >
                  Hide unreleased titles
                </Label>
                <p
                  id={`${panelId}-unreleased-help`}
                  className="text-2xs leading-snug text-muted-foreground"
                >
                  Hides titles with a release date in the future.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-xs font-semibold text-black/60">
                Extra catalogs in Stremio
              </p>
              <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
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
                          ? "border-imdb bg-imdb/10 text-ink"
                          : "border-border bg-white text-black/70 hover:border-black/20 hover:bg-black/[0.02]",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          onChange({
                            ...value,
                            presets:
                              next === true
                                ? [...(value.presets ?? []), preset.id]
                                : value.presets?.filter(
                                    (id) => id !== preset.id,
                                  ),
                          })
                        }
                      />
                      {preset.label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
