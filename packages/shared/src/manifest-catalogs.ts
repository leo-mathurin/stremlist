import { CATALOG_PRESETS } from "./catalog-settings";
import type { CatalogPreset, CatalogSettings } from "./catalog-settings";
import { SORT_OPTIONS } from "./constants";
import type { DisplayMode, TitleType } from "./constants";
import type { MergeableList } from "./list-merge";
import { isMergedList } from "./list-merge";
import { describeSourceRef, sourceTitle } from "./providers";
import type { NewTitlesSettings } from "./stremio.types";

export const DEFAULT_NEW_TITLES_SETTINGS: NewTitlesSettings = {
  catalogTitle: "Stremlist New titles",
  sortOption: "detected_at-desc",
  displayMode: "split",
  position: 0,
};

export const NEW_TITLES_SORT_OPTIONS = [
  { value: "detected_at-desc", label: "Recently detected" },
  { value: "detected_at-asc", label: "Oldest detected first" },
  ...SORT_OPTIONS.filter(({ value }) => !value.startsWith("added_at-")),
] as const;

export type NewTitlesSort = (typeof NEW_TITLES_SORT_OPTIONS)[number]["value"];

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
}) {
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
export function listTitle(list: TitledList) {
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

interface ManifestCatalogEntry extends ListCatalog {
  listId: string;
  name: string;
  search: boolean;
  genres: string[];
}

function isV1Setup(lists: TitledList[]) {
  if (lists.length !== 1) return false;
  const [list] = lists;
  return (
    !list.catalogTitle.trim() &&
    !isMergedList(list) &&
    list.provider === "imdb" &&
    describeSourceRef(list.provider, list.sourceRef).kind === "watchlist"
  );
}

/** The prefix of the Catalog names, unless the Account turned it off. */
export const CATALOG_NAME_PREFIX = "Stremlist";

function manifestCatalogEntries(lists: ManifestList[], namePrefix: boolean) {
  const v1 = namePrefix && isV1Setup(lists);
  return lists.flatMap((list) => {
    const name = v1
      ? CATALOG_NAME_PREFIX
      : namePrefix
        ? `${CATALOG_NAME_PREFIX} ${listTitle(list)}`
        : listTitle(list);
    const excluded = new Set(list.catalogSettings?.excludedGenres);
    const genres = [
      ...new Set([
        ...(list.availableGenres ?? []),
        ...(list.catalogSettings?.genres ?? []),
      ]),
    ]
      .filter((genre) => !excluded.has(genre))
      .sort();
    return listCatalogs(list).map(({ type, preset }) => {
      const label = CATALOG_PRESETS.find((entry) => entry.id === preset)?.label;
      return {
        listId: list.id,
        type,
        preset,
        name: label ? `${name} · ${label}` : name,
        search: !preset,
        genres,
      } satisfies ManifestCatalogEntry;
    });
  });
}

interface NewTitlesCatalogEntry {
  newTitles: true;
  type: TitleType;
  name: string;
  preset?: CatalogPreset;
}

export interface NewTitlesCatalogOptions {
  newTitles: boolean;
  newTitlesSettings?: NewTitlesSettings;
  /** Start each Catalog name with "Stremlist" (the default). */
  catalogNamePrefix?: boolean;
}

/** Keep the pre-existing visible types until the account saves list settings. */
export function defaultNewTitlesSettings(
  lists: Pick<ManifestList, "displayMode">[],
) {
  const [mode] = lists;
  return {
    ...DEFAULT_NEW_TITLES_SETTINGS,
    displayMode: lists.every((list) => list.displayMode === mode?.displayMode)
      ? (mode?.displayMode ?? "split")
      : "split",
  } satisfies NewTitlesSettings;
}

function newTitlesCatalogEntries(
  settings: NewTitlesSettings,
  namePrefix: boolean,
) {
  const title = settings.catalogTitle.trim();
  const name =
    title && title !== DEFAULT_NEW_TITLES_SETTINGS.catalogTitle
      ? title
      : namePrefix
        ? DEFAULT_NEW_TITLES_SETTINGS.catalogTitle
        : "New titles";
  return listCatalogs(settings).map(({ type, preset }) => {
    const label = CATALOG_PRESETS.find((entry) => entry.id === preset)?.label;
    return {
      newTitles: true,
      type,
      name: label ? `${name} · ${label}` : name,
      ...(preset ? { preset } : {}),
    } satisfies NewTitlesCatalogEntry;
  });
}

/** Every Catalog of the addon manifest, in the configured List order. */
export function addonCatalogEntries(
  lists: ManifestList[],
  options: NewTitlesCatalogOptions,
) {
  const namePrefix = options.catalogNamePrefix ?? true;
  const entries = manifestCatalogEntries(lists, namePrefix);
  if (
    !options.newTitles ||
    (!options.newTitlesSettings && lists.length === 0)
  ) {
    return entries;
  }
  const settings = options.newTitlesSettings ?? defaultNewTitlesSettings(lists);
  const before = lists
    .slice(0, settings.position)
    .reduce((count, list) => count + listCatalogs(list).length, 0);
  return [
    ...entries.slice(0, before),
    ...newTitlesCatalogEntries(settings, namePrefix),
    ...entries.slice(before),
  ];
}
