import { CATALOG_PRESETS } from "./catalog-settings";
import type { CatalogPreset, CatalogSettings } from "./catalog-settings";
import type { DisplayMode } from "./constants";

/**
 * The Catalogs that Lists add to the addon manifest. Stremio reads them only
 * when the user installs the addon, so the backend builds the manifest from
 * these entries and the configure page compares them to know when a change
 * needs a reinstall. Pure, so both use the same rules.
 */

/** One Catalog that a List adds to Stremio. */
export interface ListCatalog {
  type: "movie" | "series";
  /** The extra Catalog of a preset, or null for the List's main Catalog. */
  preset: CatalogPreset | null;
}

/**
 * The Catalogs of a List, in manifest order: each type that its display mode
 * shows, followed by the presets of that type.
 */
export function listCatalogs(list: {
  displayMode?: DisplayMode;
  catalogSettings?: CatalogSettings;
}): ListCatalog[] {
  const types: ListCatalog["type"][] =
    list.displayMode === "movie" || list.displayMode === "series"
      ? [list.displayMode]
      : ["movie", "series"];
  const presets = CATALOG_PRESETS.filter((preset) =>
    list.catalogSettings?.presets?.includes(preset.id),
  ).map((preset) => preset.id);
  return types.flatMap((type) =>
    [null, ...presets].map((preset) => ({ type, preset })),
  );
}

/** A List as far as its manifest Catalogs care. */
export interface ManifestList {
  id: string;
  catalogTitle: string;
  displayMode?: DisplayMode;
  catalogSettings?: CatalogSettings;
  /** Genres of the Titles that its Catalogs show (see `availableGenres`). */
  availableGenres?: string[];
}

/**
 * What the manifest says about one Catalog. The backend adds the Catalog ID
 * prefix and the filter options, which are the same for every Catalog.
 */
export interface ManifestCatalogEntry extends ListCatalog {
  listId: string;
  name: string;
  /** Whether the Catalog offers search (main Catalogs only). */
  search: boolean;
  /** Genre options, after the filter options. */
  genres: string[];
}

function catalogName(listTitle: string, index: number, total: number) {
  const title = listTitle.trim();
  // An empty title is the position of the List, like the backend saves it.
  const effective = title || (total <= 1 ? "" : String(index + 1));
  return effective ? `Stremlist ${effective}` : "Stremlist";
}

/** The manifest Catalogs of the Lists, in order. */
export function manifestCatalogEntries(
  lists: ManifestList[],
): ManifestCatalogEntry[] {
  return lists.flatMap((list, index) => {
    const name = catalogName(list.catalogTitle, index, lists.length);
    const genres = [
      ...new Set([
        ...(list.availableGenres ?? []),
        ...(list.catalogSettings?.genre ? [list.catalogSettings.genre] : []),
      ]),
    ].sort();
    return listCatalogs(list).map(({ type, preset }) => {
      const label = CATALOG_PRESETS.find((entry) => entry.id === preset)?.label;
      return {
        listId: list.id,
        type,
        preset,
        name: label ? `${name} · ${label}` : name,
        search: !preset,
        genres,
      };
    });
  });
}
