import { Check, Plus } from "lucide-react";
import { CHART_REGISTRY } from "@stremlist/shared/imdb-charts";
import { sourceKey } from "@stremlist/shared/list-merge";
import {
  PROVIDER_IDS,
  PROVIDERS,
  PUBLIC_SOURCES,
} from "@stremlist/shared/providers";
import type { ConnectionSource, ProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import type { ProviderStatus } from "@/hooks/useAccountConfiguration";
import { cn } from "@/lib/utils";
import BuiltInCatalogPicker from "./BuiltInCatalogPicker";
import { ProviderMark } from "./brand";

type SourceGroup = {
  provider: ProviderId;
  title: string;
  sources: ConnectionSource[];
};

/**
 * One-click additions: Source lists that a Connection unlocks, public charts
 * of other Providers, and the built-in IMDb charts.
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
  const groups: SourceGroup[] = [];
  for (const provider of PROVIDER_IDS) {
    if (!providerStatus[provider].enabled) continue;
    const label = PROVIDERS[provider].label;
    const connection = connections.find((c) => c.provider === provider);
    const fromConnection = connection ? connectionSources[provider] : null;
    if (fromConnection?.length) {
      groups.push({
        provider,
        title: connection?.username
          ? `Your ${label} (@${connection.username})`
          : `Your ${label}`,
        sources: fromConnection,
      });
    }
    const publicSources = PUBLIC_SOURCES[provider];
    if (publicSources?.length) {
      groups.push({
        provider,
        title: `${label} charts`,
        sources: publicSources,
      });
    }
  }
  const usedChartIds = CHART_REGISTRY.filter((chart) =>
    usedKeys.includes(sourceKey({ provider: "imdb", sourceRef: chart.id })),
  ).map((chart) => chart.id);

  return (
    <div className="space-y-4 rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <ProviderMark provider={group.provider} className="size-6" />
            {group.title}
          </p>
          <div className="flex flex-wrap gap-2">
            {group.sources.map((source) => {
              const added = usedKeys.includes(
                sourceKey({ provider: group.provider, sourceRef: source.ref }),
              );
              return (
                <button
                  key={source.ref}
                  type="button"
                  disabled={added || full}
                  onClick={() => onAdd(group.provider, source)}
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
                    <Plus className="size-3.5" />
                  )}
                  {source.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ProviderMark provider="imdb" className="size-6" />
          IMDb charts
        </p>
        <BuiltInCatalogPicker
          usedIds={usedChartIds}
          disabled={full}
          onAdd={onAddChart}
        />
      </div>
    </div>
  );
}
