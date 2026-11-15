import { addonCatalogEntries } from "@stremlist/shared/manifest-catalogs";
import type {
  ConfigList,
  StremioCatalog,
} from "@stremlist/shared/stremio.types";
import { CATALOG_FILTER_OPTIONS } from "./catalog-filters";
import { buildCatalogId, buildNewTitlesCatalogId } from "./catalog-id";

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
 * The manifest Catalogs: the "New titles" ones (ADR 0007) when the Account
 * has them on, then those of the Lists. The configure page compares the same
 * entries (`addonCatalogEntries`) to know when a save needs a reinstall.
 */
export function buildManifestCatalogs(
  lists: ConfigList[],
  options: { newTitles: boolean } = { newTitles: false },
): StremioCatalog[] {
  return addonCatalogEntries(lists, options).map((entry) =>
    "newTitles" in entry
      ? {
          id: buildNewTitlesCatalogId(entry.type),
          name: entry.name,
          type: entry.type,
          extra: [{ name: "skip", isRequired: false }],
        }
      : {
          id: buildCatalogId(
            entry.listId,
            entry.type,
            entry.preset ?? undefined,
          ),
          name: entry.name,
          type: entry.type,
          extra: catalogExtras(entry.genres, entry.search),
        },
  );
}
