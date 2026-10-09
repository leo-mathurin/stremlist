import { manifestCatalogEntries } from "@stremlist/shared/manifest-catalogs";
import type {
  ConfigList,
  StremioCatalog,
} from "@stremlist/shared/stremio.types";
import { CATALOG_FILTER_OPTIONS } from "./catalog-filters";
import { buildCatalogId } from "./catalog-id";

function catalogExtras(
  genres: string[],
  search: boolean,
): StremioCatalog["extra"] {
  return [
    { name: "skip", isRequired: false },
    ...(search ? [{ name: "search" as const, isRequired: false }] : []),
    {
      name: "genre",
      isRequired: false,
      options: [...new Set([...CATALOG_FILTER_OPTIONS, ...genres])],
      optionsLimit: 1,
    },
  ];
}

/**
 * The manifest Catalogs of the Lists. The configure page compares the same
 * entries (`manifestCatalogEntries`) to know when a save needs a reinstall.
 */
export function buildManifestCatalogs(lists: ConfigList[]): StremioCatalog[] {
  return manifestCatalogEntries(lists).map((entry) => ({
    id: buildCatalogId(entry.listId, entry.type, entry.preset ?? undefined),
    name: entry.name,
    type: entry.type,
    extra: catalogExtras(entry.genres, entry.search),
  }));
}
