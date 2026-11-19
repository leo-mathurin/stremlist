import {
  DEFAULT_SORT_OPTION,
  DEFAULT_DISPLAY_MODE,
} from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { ListSource } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import { listTitle } from "@stremlist/shared/manifest-catalogs";
import type { ProviderId } from "@stremlist/shared/providers";
import type { ConfigList } from "@stremlist/shared/stremio.types";

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

/**
 * A random ID for a row on this page. `crypto.randomUUID` exists only in a
 * secure context: a dev server over http:// on the tailnet has none.
 */
export function newLocalId(random: Pick<Crypto, "getRandomValues"> = crypto) {
  const bytes = random.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function createListRow(
  partial: Pick<ListFormRow, "provider" | "sourceRef"> &
    Partial<Omit<ListFormRow, "localId">>,
  random: Pick<Crypto, "getRandomValues"> = crypto,
) {
  return {
    id: partial.id,
    localId: newLocalId(random),
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

/** The rows of saved Lists. */
export function rowsFromLists(lists: ConfigList[]) {
  return lists.map((list) => createListRow(list));
}

/** The Lists of the rows, as a save sends them. */
export function listPayload(rows: ListFormRow[]) {
  return rows.map((list, index) => ({
    id: list.id,
    provider: list.provider,
    sourceRef: list.sourceRef.trim(),
    catalogTitle: list.catalogTitle.trim(),
    sortOption: list.sortOption,
    displayMode: list.displayMode,
    position: index,
    catalogSettings: list.catalogSettings,
    mergedSources: list.mergedSources,
    sourceLabel: list.sourceLabel,
  }));
}

/**
 * The title that a row shows: its own, or the name of its Source list. The
 * manifest names the List's Catalogs in Stremio with the same title.
 */
export function rowTitle(row: ListFormRow) {
  return listTitle(row);
}

/**
 * The keys of every Source list in the rows, merged ones included: a Source
 * list may be in only one List.
 */
export function sourceKeys(rows: ListFormRow[]) {
  return rows.flatMap((row) => listSources(row).map(sourceKey));
}
