import type {
  CatalogPreset,
  CatalogSettings,
} from "@stremlist/shared/catalog-settings";
import { CATALOG_DECADES } from "@stremlist/shared/catalog-settings";
import { parseSortOption } from "@stremlist/shared/constants";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { awaitsDigitalRelease } from "../titles/digital-release";
import type { DigitalRelease } from "../titles/digital-release";
import { runtimeMinutes } from "./catalog-sort";
import type { CatalogSort } from "./catalog-sort";

interface Selection {
  sort?: CatalogSort;
  filters?: CatalogSettings;
}
const OPTIONS = new Map<string, Selection>([
  ...[
    ["Date Added (Newest)", "added_at-desc"],
    ["Date Added (Oldest)", "added_at-asc"],
    ["Title (A-Z)", "title-asc"],
    ["Title (Z-A)", "title-desc"],
    ["Release Year (Newest)", "year-desc"],
    ["Release Year (Oldest)", "year-asc"],
    ["IMDb Rating (Highest)", "rating-desc"],
    ["IMDb Rating (Lowest)", "rating-asc"],
    ["Shuffle", "random"],
  ].map(
    ([label, sort]) =>
      [label, { sort: parseSortOption(sort) }] satisfies [string, Selection],
  ),
  ["Shortest", { sort: { by: "runtime", order: "asc" } }],
  ["Longest", { sort: { by: "runtime", order: "desc" } }],
  ["90 min or less", { filters: { maxRuntime: 90 } }],
  ["120 min or less", { filters: { maxRuntime: 120 } }],
  ["IMDb Rating 7+", { filters: { minRating: 7 } }],
  ["IMDb Rating 8+", { filters: { minRating: 8 } }],
  ["Release Date (Newest)", { sort: { by: "released", order: "desc" } }],
  ["Release Date (Oldest)", { sort: { by: "released", order: "asc" } }],
  ...CATALOG_DECADES.map(
    (decade) =>
      [decade, { filters: { decade: Number.parseInt(decade, 10) } }] satisfies [
        string,
        Selection,
      ],
  ),
]);
const PRESETS = {
  short: { filters: { maxRuntime: 90 } },
  rated: { sort: parseSortOption("rating-desc") },
  shuffle: { sort: parseSortOption("random") },
} satisfies Record<CatalogPreset, Selection>;

/** Stremio exposes one genre dropdown for either a filter or a sort. */
export const CATALOG_FILTER_OPTIONS = [...OPTIONS.keys()];

export function resolveCatalogSelection(
  savedSort: string,
  settings: CatalogSettings = {},
  filter: string | null = null,
  preset?: CatalogPreset,
) {
  const selected = OPTIONS.get(filter ?? "") ?? {
    filters: { genre: filter ?? undefined },
  };
  const defaults: {
    sort?: ReturnType<typeof parseSortOption>;
    filters?: CatalogSettings;
  } = preset ? PRESETS[preset] : {};
  const baseSort = defaults.sort ?? parseSortOption(savedSort);
  const sort = selected.sort ?? baseSort;
  return {
    sort:
      sort.by === "runtime" || sort.by === "released"
        ? { ...sort, tieBreak: baseSort }
        : sort,
    filters: [settings, defaults.filters ?? {}, selected.filters ?? {}],
  };
}

function isUnreleased(meta: StremioMeta, now = Date.now()) {
  const released = Date.parse(meta.released ?? "");
  if (Number.isFinite(released)) return released > now;
  const year = Number.parseInt(meta.releaseInfo ?? "", 10);
  return year > new Date(now).getUTCFullYear();
}

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function filterCatalog<T extends StremioMeta & DigitalRelease>(
  metas: T[],
  filters: CatalogSettings[],
  search?: string | null,
) {
  const query = search == null ? null : normalizeSearch(search);
  return metas.filter(
    (meta) =>
      filters.every((settings) => {
        if (settings.genre && !meta.genres.includes(settings.genre))
          return false;
        if (settings.decade !== undefined) {
          const year = Number.parseInt(meta.releaseInfo ?? "", 10);
          if (!(year >= settings.decade && year < settings.decade + 10))
            return false;
        }
        if (settings.maxRuntime !== undefined) {
          const runtime = runtimeMinutes(meta.runtime);
          if (runtime === null || runtime > settings.maxRuntime) return false;
        }
        if (
          settings.minRating !== undefined &&
          !(Number.parseFloat(meta.imdbRating ?? "") >= settings.minRating)
        )
          return false;
        if (settings.hideUnreleased && isUnreleased(meta)) return false;
        if (settings.hideUnreleased === "digital" && awaitsDigitalRelease(meta))
          return false;
        return true;
      }) &&
      (query === null ||
        (query.length > 0 && normalizeSearch(meta.name).includes(query))),
  );
}
