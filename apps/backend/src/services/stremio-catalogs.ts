import { addonCatalogEntries } from "@stremlist/shared/manifest-catalogs";
import type { NewTitlesCatalogOptions } from "@stremlist/shared/manifest-catalogs";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { CATALOG_FILTER_OPTIONS } from "./catalog-filters";
import { buildCatalogId, buildNewTitlesCatalogId } from "./catalog-id";

function catalogExtras(genres: string[], search: boolean) {
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

/** The manifest and configure page use the same Catalog ordering and names. */
export function buildManifestCatalogs(
  lists: ConfigList[],
  options: NewTitlesCatalogOptions = { newTitles: false },
) {
  return addonCatalogEntries(lists, options).map((entry) =>
    "newTitles" in entry
      ? {
          id: buildNewTitlesCatalogId(entry.type, entry.preset),
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
