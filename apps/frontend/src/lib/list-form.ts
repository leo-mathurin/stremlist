import {
  DEFAULT_SORT_OPTION,
  DEFAULT_DISPLAY_MODE,
} from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { ListSource } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import { describeSource } from "./list-sources";

/** The backend accepts catalog titles up to this length. */
export const MAX_CATALOG_TITLE_LENGTH = 60;

/** One List as the configure page edits it. */
export type ListFormRow = {
  id?: string;
  localId: string;
  provider: ProviderId;
  sourceRef: string;
  catalogTitle: string;
  sortOption: string;
  displayMode: DisplayMode;
  catalogSettings: CatalogSettings;
  availableGenres: string[];
  /** Source lists merged after the first one; empty for most Lists. */
  mergedSources: ListSource[];
  /** The label of the first Source list, when it was merged in earlier. */
  sourceLabel?: string;
};

export function createListRow(
  partial: Pick<ListFormRow, "provider" | "sourceRef"> &
    Partial<Omit<ListFormRow, "localId">>,
): ListFormRow {
  return {
    id: partial.id,
    localId: crypto.randomUUID(),
    provider: partial.provider,
    sourceRef: partial.sourceRef,
    catalogTitle: (partial.catalogTitle ?? "").slice(
      0,
      MAX_CATALOG_TITLE_LENGTH,
    ),
    sortOption: partial.sortOption ?? DEFAULT_SORT_OPTION,
    displayMode: partial.displayMode ?? DEFAULT_DISPLAY_MODE,
    catalogSettings: partial.catalogSettings ?? {},
    availableGenres: partial.availableGenres ?? [],
    mergedSources: partial.mergedSources ?? [],
    ...(partial.sourceLabel ? { sourceLabel: partial.sourceLabel } : {}),
  };
}

/** The title that a row shows: its own, or the one its Source list suggests. */
export function rowTitle(row: ListFormRow): string {
  return (
    row.catalogTitle.trim() ||
    describeSource(row.provider, row.sourceRef).suggestedTitle
  );
}

/**
 * The keys of every Source list in the rows, merged ones included: a Source
 * list may be in only one List.
 */
export function sourceKeys(rows: ListFormRow[]): string[] {
  return rows.flatMap((row) => listSources(row).map(sourceKey));
}
