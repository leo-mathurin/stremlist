import type { StremioMeta } from "@stremlist/shared";
import { describe, expect, it } from "vitest";
import { filterCatalog, resolveCatalogSelection } from "../catalog-filters";

import { sortWatchlist } from "../watchlist-sort";

const base: StremioMeta = {
  id: "tt1",
  name: "Film",
  type: "movie",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
};
const metas: StremioMeta[] = [
  {
    ...base,
    id: "tt1",
    runtime: "1h 30m",
    imdbRating: "8",
    releaseInfo: "2000",
    released: "2000-10-01T00:00:00.000Z",
  },
  {
    ...base,
    id: "tt2",
    runtime: "2h 0m",
    imdbRating: "7",
    releaseInfo: "2000",
    released: "2000-01-01T00:00:00.000Z",
  },
  { ...base, id: "tt3", runtime: "2h 1m", imdbRating: "6" },
  { ...base, id: "tt4" },
];

describe("catalog selection", () => {
  it.each([
    ["90 min or less", ["tt1"]],
    ["120 min or less", ["tt1", "tt2"]],
    ["IMDb Rating 7+", ["tt1", "tt2"]],
    ["IMDb Rating 8+", ["tt1"]],
    ["Release Date (Newest)", ["tt1", "tt2", "tt3", "tt4"]],
    ["Release Date (Oldest)", ["tt2", "tt1", "tt3", "tt4"]],
  ])("applies %s including bounds and missing data", (filter, ids) => {
    const selection = resolveCatalogSelection("added_at-asc", {}, filter);
    expect(
      filterCatalog(
        sortWatchlist(metas, selection.sort, "test"),
        selection.filters,
      ).map((meta) => meta.id),
    ).toEqual(ids);
    expect(metas.map((meta) => meta.id)).toEqual(["tt1", "tt2", "tt3", "tt4"]);
  });
});

it.each([
  "Shortest",
  "Longest",
  "Release Date (Newest)",
  "Release Date (Oldest)",
])(
  "uses saved/preset ordering for %s ties, including missing values",
  (filter) => {
    const ties = metas.map((meta) => ({
      ...meta,
      runtime: undefined,
      released: undefined,
    }));
    for (const preset of [undefined, "rated", "shuffle"] as const) {
      const fallback = resolveCatalogSelection(
        "added_at-desc",
        {},
        null,
        preset,
      );
      const selected = resolveCatalogSelection(
        "added_at-desc",
        {},
        filter,
        preset,
      );
      expect(sortWatchlist(ties, selected.sort, "generation")).toEqual(
        sortWatchlist(ties, fallback.sort, "generation"),
      );
    }
  },
);

it("intersects saved and dropdown constraints rather than overwriting either", () => {
  const both = [
    { ...metas[0], genres: ["Drama", "Comedy"] },
    { ...metas[1], genres: ["Drama"] },
  ];
  for (const [filter, settings, ids] of [
    ["Comedy", { genre: "Drama" }, ["tt1"]],
    ["1990s", { decade: 2000 }, []],
    ["120 min or less", { maxRuntime: 90 }, ["tt1"]],
    ["90 min or less", { maxRuntime: 120 }, ["tt1"]],
    ["IMDb Rating 7+", { minRating: 8 }, ["tt1"]],
    ["IMDb Rating 8+", { minRating: 7 }, ["tt1"]],
  ] as const) {
    const selection = resolveCatalogSelection("added_at-asc", settings, filter);
    expect(
      filterCatalog(both, selection.filters).map((meta) => meta.id),
    ).toEqual(ids);
  }
});
