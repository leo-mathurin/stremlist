import {
  DEFAULT_SORT_OPTION,
  DEFAULT_DISPLAY_MODE,
} from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { ProviderId } from "@stremlist/shared/providers";

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
};

/**
 * Stremio reads the manifest catalogs only at install time. This signature
 * covers everything that changes the catalogs, so the page can tell the user
 * when a reinstall is needed.
 */
export function getListReinstallSignature(rows: ListFormRow[]): string {
  return rows
    .map((row, index) =>
      [
        index,
        row.id ?? row.localId,
        row.provider,
        row.sourceRef.trim(),
        row.catalogTitle.trim(),
        row.displayMode,
        [...(row.catalogSettings.presets ?? [])].sort().join(","),
      ].join("|"),
    )
    .join("::");
}

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
  };
}

/** Lists are unique by Provider and Source list reference. */
export function listKey(row: Pick<ListFormRow, "provider" | "sourceRef">) {
  return `${row.provider}:${row.sourceRef}`;
}
