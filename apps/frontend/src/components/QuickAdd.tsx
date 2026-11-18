import { useState } from "react";
import { Check, ChevronDown, ExternalLink } from "lucide-react";
import { CHART_REGISTRY } from "@stremlist/shared/imdb-charts";
import { sourceKey } from "@stremlist/shared/list-merge";
import {
  PROVIDER_IDS,
  PROVIDERS,
  PUBLIC_SOURCES,
} from "@stremlist/shared/providers";
import type { ConnectionSource, ProviderId } from "@stremlist/shared/providers";
import { sourcePageUrl } from "@stremlist/shared/source-pages";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import type { ProviderStatus } from "@/hooks/useProviderStatus";
import { PlusIcon } from "@/components/ui/plus-icon";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./brand";

type Chip = {
  key: string;
  label: string;
  added: boolean;
  onAdd: () => void;
  /** The list's own page on the Provider. */
  url?: string;
  /** A longer description, shown on hover. */
  hint?: string;
};
type Section = { title: string; chips: Chip[] };
type ProviderEntry = {
  provider: ProviderId;
  /** "@moviebuff, 28 lists" or "13 charts". */
  summary: string;
  added: number;
  sections: Section[];
};

/** The IMDb charts in "Popular now"; the others sort by rating. */
const IMDB_POPULAR = new Set([
  "imdb:most-popular-movies",
  "imdb:most-popular-tv",
  "imdb:box-office",
  "imdb:coming-soon-movies",
  "imdb:coming-soon-tv",
]);

/** A list the user made, imported or follows, not one the Provider makes. */
function isOwnList(ref: string) {
  return /^(me\/(lists|smart-lists|external)\/|users\/|lists\/)/.test(ref);
}

/**
 * One-click additions, one Provider at a time: the Source lists that a
 * Connection unlocks, the public charts of the Providers, and the built-in
 * IMDb charts. Only one Provider is open, so the many list types stay calm.
 */
export default function QuickAdd({
  connections,
  connectionSources,
  providerStatus,
  usedKeys,
  full,
  onAdd,
  onAddChart,
}: {
  connections: ConnectionSummary[];
  /** What each Connection unlocks, from the backend. */
  connectionSources: Partial<Record<ProviderId, ConnectionSource[]>>;
  providerStatus: Record<ProviderId, ProviderStatus>;
  /** `provider:sourceRef` of the Lists already added. */
  usedKeys: string[];
  full: boolean;
  onAdd: (provider: ProviderId, source: ConnectionSource) => void;
  onAddChart: (chartId: string) => void;
}) {
  const isAdded = (provider: ProviderId, sourceRef: string) =>
    usedKeys.includes(sourceKey({ provider, sourceRef }));

  const entries: ProviderEntry[] = [];
  for (const provider of PROVIDER_IDS) {
    if (provider === "imdb" || !providerStatus[provider].enabled) continue;
    const connection = connections.find((c) => c.provider === provider);
    const mine = (connection && connectionSources[provider]) || [];
    const charts = [
      ...mine.filter((source) => source.kind === "chart"),
      ...(PUBLIC_SOURCES[provider] ?? []),
    ].filter(
      (source, index, all) =>
        all.findIndex((other) => other.ref === source.ref) === index,
    );
    const chip = (source: ConnectionSource): Chip => ({
      key: source.ref,
      label: source.label,
      added: isAdded(provider, source.ref),
      onAdd: () => onAdd(provider, source),
      url:
        source.url ?? sourcePageUrl(provider, source.ref, connection?.username),
    });
    const sections = [
      {
        title: "Follow what you watch",
        chips: mine
          .filter((s) => s.kind !== "chart" && !isOwnList(s.ref))
          .map(chip),
      },
      {
        title: "Your lists",
        chips: mine.filter((s) => isOwnList(s.ref)).map(chip),
      },
      { title: "Charts", chips: charts.map(chip) },
    ].filter((section) => section.chips.length > 0);
    if (sections.length === 0) continue;
    const count = sections.reduce((sum, s) => sum + s.chips.length, 0);
    const counted = mine.length > 0 ? `${count} lists` : `${count} charts`;
    entries.push({
      provider,
      summary: connection?.username
        ? `@${connection.username}, ${counted}`
        : counted,
      added: sections.flatMap((s) => s.chips).filter((c) => c.added).length,
      sections,
    });
  }

  const imdbChips = CHART_REGISTRY.map((chart) => ({
    popular: IMDB_POPULAR.has(chart.id),
    chip: {
      key: chart.id,
      label: chart.label,
      added: isAdded("imdb", chart.id),
      onAdd: () => onAddChart(chart.id),
      url: chart.url,
      hint: chart.description,
    } satisfies Chip,
  }));
  entries.push({
    provider: "imdb",
    summary: `${CHART_REGISTRY.length} charts`,
    added: imdbChips.filter((c) => c.chip.added).length,
    sections: [
      {
        title: "Popular now",
        chips: imdbChips.filter((c) => c.popular).map((c) => c.chip),
      },
      {
        title: "Ratings",
        chips: imdbChips.filter((c) => !c.popular).map((c) => c.chip),
      },
    ],
  });

  // Until the user picks a row, open the newest Connection's Provider, so
  // its lists show right after it connects. The lists of a Connection load
  // after the first render, so this default is read again on each render.
  const [picked, setPicked] = useState<ProviderId | null>();
  const newest = connections
    .filter((c) => entries.some((entry) => entry.provider === c.provider))
    .reduce<ConnectionSummary | undefined>(
      (latest, c) =>
        !latest || c.connectedAt > latest.connectedAt ? c : latest,
      undefined,
    );
  const open =
    picked === undefined ? (newest?.provider ?? entries[0].provider) : picked;

  return (
    <div className="divide-y divide-black/5 rounded-3xl bg-white ring-1 ring-black/5">
      {entries.map((entry) => {
        const isOpen = open === entry.provider;
        const label = PROVIDERS[entry.provider].label;
        const panelId = `quick-add-${entry.provider}`;
        return (
          <div key={entry.provider}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              data-testid={`quick-add-${entry.provider}`}
              onClick={() => setPicked(isOpen ? null : entry.provider)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 outline-none first:rounded-t-3xl last:rounded-b-3xl hover:bg-black/[0.02] focus-visible:bg-black/[0.03] sm:px-5"
            >
              <ProviderMark provider={entry.provider} className="size-7" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block truncate text-xs text-black/50 tabular-nums">
                  {entry.summary}
                  {entry.added > 0 ? `, ${entry.added} added` : ""}
                </span>
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-4 text-black/40 transition-transform duration-200 ease-[var(--ease-out-quint)] motion-reduce:transition-none",
                  isOpen && "rotate-180",
                )}
              />
            </button>
            <div
              id={panelId}
              inert={!isOpen}
              className={cn(
                "grid transition-[grid-template-rows] ease-[var(--ease-out-quint)] motion-reduce:transition-none",
                isOpen
                  ? "grid-rows-[1fr] duration-[260ms]"
                  : "grid-rows-[0fr] duration-200",
              )}
            >
              <div className="overflow-hidden">
                <div
                  className={cn(
                    "space-y-4 px-4 pb-4 sm:px-5 sm:pb-5",
                    isOpen ? "quick-add-reveal" : "quick-add-hide",
                  )}
                >
                  {entry.sections.map((section) => (
                    <div key={section.title}>
                      <p className="mb-2 text-sm font-medium text-black/50">
                        {section.title}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {section.chips.map((chip) => (
                          <SourceChip
                            key={chip.key}
                            chip={chip}
                            full={full}
                            provider={label}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A chip in two parts in one pill: the label adds the list, and the small
 * arrow opens the list's own page in a new tab.
 */
function SourceChip({
  chip: { label, added, onAdd, url, hint },
  full,
  provider,
}: {
  chip: Chip;
  full: boolean;
  provider: string;
}) {
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex h-8 items-stretch overflow-hidden rounded-full text-xs font-semibold",
        added ? "bg-brand/20 text-black/70" : "bg-black/5",
      )}
    >
      <button
        type="button"
        disabled={added || full}
        onClick={onAdd}
        className={cn(
          "inline-flex items-center gap-1.5 pl-3 transition-[background-color,scale] duration-150 active:scale-[0.96] disabled:cursor-not-allowed",
          url ? "pr-2" : "pr-3",
          !added && "hover:bg-black/5 disabled:opacity-40",
        )}
      >
        {added ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
        {label}
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${label} on ${provider}`}
          title={`Open on ${provider}`}
          className="inline-flex items-center border-l border-black/10 pr-2.5 pl-2 text-black/35 transition-colors duration-150 hover:bg-black/5 hover:text-black"
        >
          <ExternalLink aria-hidden className="size-3" />
        </a>
      )}
    </span>
  );
}
