import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { ListSource, MergeableList } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import { addonCatalogEntries } from "@stremlist/shared/manifest-catalogs";
import type { ConfigList, TitleGenres } from "@stremlist/shared/stremio.types";

/** A List row of the configure page, as far as the manifest cares. */
export type SignatureRow = MergeableList & {
  id?: string;
  localId: string;
  catalogTitle: string;
  displayMode: DisplayMode;
  catalogSettings: CatalogSettings;
};

/**
 * The genres of each Source list that the page has seen, by `sourceKey`.
 * A merged List offers the genres of all its Source lists in Stremio.
 */
export type KnownSourceGenres = Record<string, TitleGenres>;

/**
 * Add the genres that a server answer gives for each Source list. A Source
 * list whose cache is not written yet (null) keeps the genres seen before:
 * a List that becomes merged, or stops being merged, moves its Source lists
 * to new cache keys, and they have their genres again after their next read.
 */
export function learnSourceGenres(
  known: KnownSourceGenres,
  lists: (ListSource & Pick<ConfigList, "mergedSources" | "sourceGenres">)[],
): KnownSourceGenres {
  const next = { ...known };
  for (const list of lists) {
    listSources(list).forEach((source, index) => {
      const genres = list.sourceGenres?.[index];
      if (genres) next[sourceKey(source)] = genres;
    });
  }
  return next;
}

/** The genres that a List's Catalogs offer, as the backend computes them. */
function listGenres(row: SignatureRow, known: KnownSourceGenres): string[] {
  return listSources(row).flatMap((source) => {
    const genres = known[sourceKey(source)];
    if (!genres) return [];
    return row.displayMode === "split"
      ? [...genres.movie, ...genres.series]
      : genres[row.displayMode];
  });
}

/**
 * Stremio reads the manifest Catalogs only at install time: their IDs,
 * names, types and genre options (`addonCatalogEntries`, the same rules
 * as the backend manifest), "New titles" ones included when `newTitles` is
 * on. The signature is those Catalogs, so it changes
 * exactly when they change. Every Source list of a List counts through the
 * genres it brings; the sort, the posters and the Source list labels do not.
 * A Source list without known genres brings none.
 */
export function getListReinstallSignature(
  rows: SignatureRow[],
  known: KnownSourceGenres,
  options: { newTitles: boolean } = { newTitles: false },
): string {
  return JSON.stringify(
    addonCatalogEntries(
      rows.map((row) => ({
        id: row.id ?? row.localId,
        catalogTitle: row.catalogTitle,
        displayMode: row.displayMode,
        catalogSettings: row.catalogSettings,
        availableGenres: listGenres(row, known),
      })),
      options,
    ),
  );
}
