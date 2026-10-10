import type { Tables } from "@stremlist/shared/database.types";
import type { ListSource } from "@stremlist/shared/list-merge";
import { isProviderId } from "@stremlist/shared/providers";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { z } from "zod";
import { catalogSettingsSchema } from "./catalog-settings";
import { sourceCaches } from "./merged-lists";

/*
 * The stored form of a List (`lists` rows), without a database client, so
 * scripts that bring their own client can use it too.
 */

type ListRow = Tables<"lists">;

const storedSourcesSchema = z.array(
  z.object({
    provider: z.string(),
    source_ref: z.string(),
    label: z.string().optional(),
  }),
);

/** The stored form of merged Source lists (`lists.merged_sources`). */
export function toStoredSources(sources: readonly ListSource[]) {
  return sources.map((source) => ({
    provider: source.provider,
    source_ref: source.sourceRef,
    ...(source.label ? { label: source.label } : {}),
  }));
}

/** The merged Source lists of a row; unknown Providers are left out. */
function mapMergedSources(value: unknown): ListSource[] {
  const parsed = storedSourcesSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.flatMap(({ provider, source_ref, label }) =>
    isProviderId(provider)
      ? [{ provider, sourceRef: source_ref, ...(label ? { label } : {}) }]
      : [],
  );
}

/** A List row as the app reads it; null for a Provider it does not know. */
export function mapList(row: ListRow): ConfigList | null {
  if (!isProviderId(row.provider)) return null;
  const settings = catalogSettingsSchema.safeParse(row.catalog_settings);
  const mergedSources = mapMergedSources(row.merged_sources);
  return {
    id: row.id,
    provider: row.provider,
    sourceRef: row.source_ref,
    catalogTitle: row.catalog_title,
    sortOption: row.sort_option,
    displayMode: row.display_mode as ConfigList["displayMode"],
    position: row.position,
    ...(settings.success && Object.keys(settings.data).length > 0
      ? { catalogSettings: settings.data }
      : {}),
    ...(mergedSources.length > 0 ? { mergedSources } : {}),
    ...(row.source_label ? { sourceLabel: row.source_label } : {}),
  };
}

/**
 * Every R2 cache key of these List rows: the List ID for a List with one
 * Source list, and one key per Source list for a merged List (ADR 0006). A
 * row of a Provider the app does not know keeps the List ID.
 */
export function listRowCacheKeys(rows: ListRow[]): string[] {
  return rows.flatMap((row) => {
    const list = mapList(row);
    return list ? sourceCaches(list).map(({ cacheKey }) => cacheKey) : [row.id];
  });
}
