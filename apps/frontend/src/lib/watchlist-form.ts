import {
  DEFAULT_SORT_OPTION,
  DEFAULT_DISPLAY_MODE,
} from "@stremlist/shared/constants";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";

export type WatchlistFormRow = {
  id?: string;
  localId: string;
  imdbUserId: string;
  catalogTitle: string;
  sortOption: string;
  displayMode: string;
  catalogSettings: CatalogSettings;
  availableGenres: string[];
};

export function getWatchlistReinstallSignature(
  rows: WatchlistFormRow[],
): string {
  return rows
    .map((row, index) => ({
      index,
      id: row.id ?? row.localId,
      imdbUserId: row.imdbUserId.trim(),
      catalogTitle: row.catalogTitle.trim(),
      displayMode: row.displayMode,
      presets: [...(row.catalogSettings.presets ?? [])].sort().join(","),
    }))
    .map(
      (item) =>
        `${item.index}|${item.id}|${item.imdbUserId}|${item.catalogTitle}|${item.displayMode}|${item.presets}`,
    )
    .join("::");
}

export function createWatchlistRow(
  partial?: Partial<Omit<WatchlistFormRow, "localId">>,
): WatchlistFormRow {
  return {
    id: partial?.id,
    localId: crypto.randomUUID(),
    imdbUserId: partial?.imdbUserId ?? "",
    catalogTitle: partial?.catalogTitle ?? "",
    sortOption: partial?.sortOption ?? DEFAULT_SORT_OPTION,
    displayMode: partial?.displayMode ?? DEFAULT_DISPLAY_MODE,
    catalogSettings: partial?.catalogSettings ?? {},
    availableGenres: partial?.availableGenres ?? [],
  };
}
