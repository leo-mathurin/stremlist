import { useState } from "react";
import { Check } from "lucide-react";
import { PlusIcon } from "@/components/ui/plus-icon";
import { sourceKey } from "@stremlist/shared/list-merge";
import { sourceTitle, staticSource } from "@stremlist/shared/providers";
import type { ConnectionSource } from "@stremlist/shared/providers";
import {
  SIMKL_CHART_PERIODS,
  SIMKL_CHART_TYPE_INFO,
  SIMKL_CHART_TYPES,
  SIMKL_GENRES,
  isSimklChartPeriod,
  isSimklChartType,
  simklGenreRef,
  simklTrendingRef,
} from "@stremlist/shared/simkl-charts";
import type {
  SimklChartPeriod,
  SimklChartType,
} from "@stremlist/shared/simkl-charts";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PERIOD_LABELS: Record<SimklChartPeriod, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
};

/** A chart value: a period, or `genre:{slug}`. */
const GENRE_PREFIX = "genre:";

function chartRef(type: SimklChartType, chart: string): string {
  return isSimklChartPeriod(chart)
    ? simklTrendingRef(type, chart)
    : simklGenreRef(type, chart.slice(GENRE_PREFIX.length));
}

/** The Source list to add: a fixed chart, or a genre chart. */
function chartSource(ref: string, type: SimklChartType): ConnectionSource {
  const known = staticSource("simkl", ref);
  if (known) return known;
  const { defaultDisplayMode, titleType } = SIMKL_CHART_TYPE_INFO[type];
  return {
    ref,
    kind: "chart",
    label: sourceTitle("simkl", ref),
    defaultDisplayMode,
    ...(titleType ? { titleType } : {}),
  };
}

const triggerClass =
  "h-8 gap-1.5 rounded-full border-0 bg-black/5 px-3 text-xs font-semibold shadow-none hover:bg-black/10";

/**
 * Simkl's other trending charts: today, this month, and this month by genre.
 * The week's charts have their own buttons.
 */
export default function SimklChartPicker({
  usedKeys,
  disabled,
  onAdd,
}: {
  /** `provider:sourceRef` of the Lists already added. */
  usedKeys: string[];
  disabled: boolean;
  onAdd: (source: ConnectionSource) => void;
}) {
  const [type, setType] = useState<SimklChartType>("movies");
  const [chart, setChart] = useState<string>("today");
  const ref = chartRef(type, chart);
  const added = usedKeys.includes(
    sourceKey({ provider: "simkl", sourceRef: ref }),
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Select
        value={type}
        onValueChange={(next) => {
          if (!isSimklChartType(next)) return;
          setType(next);
          // Each type has its own genres.
          const slug = chart.startsWith(GENRE_PREFIX)
            ? chart.slice(GENRE_PREFIX.length)
            : null;
          if (slug && !SIMKL_GENRES[next].some(([known]) => known === slug)) {
            setChart("month");
          }
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Simkl chart type"
          className={triggerClass}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIMKL_CHART_TYPES.map((option) => (
            <SelectItem key={option} value={option}>
              {SIMKL_CHART_TYPE_INFO[option].noun}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={chart} onValueChange={setChart}>
        <SelectTrigger
          size="sm"
          aria-label="Simkl chart"
          className={triggerClass}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-[min(22rem,60vh)]">
          <SelectGroup>
            <SelectLabel>Trending</SelectLabel>
            {SIMKL_CHART_PERIODS.map((period) => (
              <SelectItem key={period} value={period}>
                {PERIOD_LABELS[period]}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectGroup>
            <SelectLabel>Trending this month, by genre</SelectLabel>
            {SIMKL_GENRES[type].map(([slug, name]) => (
              <SelectItem key={slug} value={`${GENRE_PREFIX}${slug}`}>
                {name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <button
        type="button"
        disabled={added || disabled}
        onClick={() => onAdd(chartSource(ref, type))}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-[background-color,scale] duration-150 active:scale-[0.96] disabled:cursor-not-allowed",
          added
            ? "bg-brand/20 text-black/70"
            : "bg-black/5 hover:bg-black/10 disabled:opacity-40",
        )}
      >
        {added ? (
          <Check className="size-3.5" />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
        {added ? "Added" : "Add chart"}
      </button>
    </div>
  );
}
