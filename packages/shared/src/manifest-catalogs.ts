import { CATALOG_PRESETS } from "./catalog-settings";
import type { CatalogPreset, CatalogSettings } from "./catalog-settings";
import type { DisplayMode, TitleType } from "./constants";
import type { MergeableList } from "./list-merge";
import { isMergedList } from "./list-merge";
import { describeSourceRef, sourceTitle } from "./providers";

/**
 * The Catalogs that Lists add to the addon manifest. Stremio reads them only
 * when the user installs the addon, so the backend builds the manifest from
 * these entries and the configure page compares them to know when a change
 * needs a reinstall. Pure, so both use the same rules.
 */

/** One Catalog that a List adds to Stremio. */
export interface ListCatalog {
  type: TitleType;
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
  const types: TitleType[] =
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

/** A List as far as its title cares: its own title, then its Source lists. */
type TitledList = MergeableList & { catalogTitle: string };

/**
 * The title of a List: the one the user gave it, or else the name of its
 * first Source list. The configure page shows it and the manifest names the
 * List's Catalogs with it, so both agree. It never depends on the position
 * of the List, so adding or moving Lists renames no other List.
 */
export function listTitle(list: TitledList): string {
  return list.catalogTitle.trim() || sourceTitle(list.provider, list.sourceRef);
}

/** A List as far as its manifest Catalogs care. */
interface ManifestList extends TitledList {
  id: string;
  displayMode?: DisplayMode;
  catalogSettings?: CatalogSettings;
  /** Genres of the Titles that its Catalogs show (see `availableGenres`). */
  availableGenres?: string[];
}

/**
 * What the manifest says about one Catalog. The backend adds the Catalog ID
 * prefix and the filter options, which are the same for every Catalog.
 */
interface ManifestCatalogEntry extends ListCatalog {
  listId: string;
  name: string;
  /** Whether the Catalog offers search (main Catalogs only). */
  search: boolean;
  /** Genre options, after the filter options. */
  genres: string[];
}

/**
 * A v1 install: one IMDb watchlist without a title, the only setup that v1
 * saved without a title. v1 named its Catalogs "Stremlist", and they keep
 * that name while the List is alone.
 */
function isV1Setup(lists: TitledList[]): boolean {
  if (lists.length !== 1) return false;
  const [list] = lists;
  return (
    !list.catalogTitle.trim() &&
    !isMergedList(list) &&
    list.provider === "imdb" &&
    describeSourceRef(list.provider, list.sourceRef).kind === "watchlist"
  );
}

/** The manifest Catalogs of the Lists, in order (see addonCatalogEntries). */
function manifestCatalogEntries(lists: ManifestList[]): ManifestCatalogEntry[] {
  const v1 = isV1Setup(lists);
  return lists.flatMap((list) => {
    const name = v1 ? "Stremlist" : `Stremlist ${listTitle(list)}`;
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

/** What the manifest says about one "New titles" Catalog (ADR 0007). */
interface NewTitlesCatalogEntry {
  newTitles: true;
  type: TitleType;
  name: string;
}

/** One "New titles" Catalog per type that the Lists show. */
function newTitlesCatalogEntries(
  lists: ManifestList[],
): NewTitlesCatalogEntry[] {
  const types = new Set(
    lists.flatMap((list) => listCatalogs(list).map((catalog) => catalog.type)),
  );
  return (["movie", "series"] as const)
    .filter((type) => types.has(type))
    .map((type) => ({ newTitles: true, type, name: "Stremlist New titles" }));
}

/**
 * Every Catalog of the addon manifest, in order. The "New titles" Catalogs,
 * when the Account has them on, come first: they sum up what changed in
 * every List below.
 */
export function addonCatalogEntries(
  lists: ManifestList[],
  options: { newTitles: boolean },
): (NewTitlesCatalogEntry | ManifestCatalogEntry)[] {
  return [
    ...(options.newTitles ? newTitlesCatalogEntries(lists) : []),
    ...manifestCatalogEntries(lists),
  ];
}
