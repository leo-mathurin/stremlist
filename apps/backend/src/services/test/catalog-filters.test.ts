import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import { describe, expect, it } from "vite-plus/test";
import { movie } from "../../test/helpers/account.fixture";
import { filterCatalog, resolveCatalogSelection } from "../catalog-filters";
import { sortCatalog } from "../catalog-sort";

const metas = [
  movie("tt1", {
    runtime: "1h 30m",
    imdbRating: "8",
    releaseInfo: "2000",
    released: "2000-10-01T00:00:00.000Z",
  }),
  movie("tt2", {
    runtime: "2h 0m",
    imdbRating: "7",
    releaseInfo: "2000",
    released: "2000-01-01T00:00:00.000Z",
  }),
  movie("tt3", { runtime: "2h 1m", imdbRating: "6" }),
  movie("tt4"),
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
        sortCatalog(metas, selection.sort, "test"),
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
      expect(sortCatalog(ties, selected.sort, "generation")).toEqual(
        sortCatalog(ties, fallback.sort, "generation"),
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
  for (const [filter, settings, ids] of [
    ["Comedy", { genres: ["Drama"] }, ["tt1"]],
    ["Drama", { excludedGenres: ["Comedy"] }, ["tt2"]],
  ] satisfies [string, CatalogSettings, string[]][]) {
    const selection = resolveCatalogSelection("added_at-asc", settings, filter);
    expect(
      filterCatalog(both, selection.filters).map((meta) => meta.id),
    ).toEqual(ids);
  }
});

it("keeps Titles with any included genre and hides Titles with any excluded genre", () => {
  const titles = [
    { ...metas[0], id: "tt30", genres: ["Horror"] },
    { ...metas[0], id: "tt31", genres: ["Thriller", "Comedy"] },
    { ...metas[0], id: "tt32", genres: ["Drama"] },
    { ...metas[0], id: "tt33", genres: ["Horror", "Thriller"] },
  ];
  const ids = (settings: CatalogSettings) =>
    filterCatalog(titles, [settings]).map((meta) => meta.id);
  expect(ids({ genres: ["Horror", "Thriller"] })).toEqual([
    "tt30",
    "tt31",
    "tt33",
  ]);
  expect(ids({ excludedGenres: ["Comedy", "Drama"] })).toEqual([
    "tt30",
    "tt33",
  ]);
  expect(
    ids({ genres: ["Horror", "Thriller"], excludedGenres: ["Comedy"] }),
  ).toEqual(["tt30", "tt33"]);
  expect(ids({ genres: ["Horror"], excludedGenres: ["Horror"] })).toEqual([]);
});

it("hides unreleased Titles: a future date, or no date and a later year", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const year = new Date(now).getUTCFullYear();
  const titles = [
    movie("tt20", { released: new Date(now - day).toISOString() }),
    movie("tt21", { released: new Date(now + day).toISOString() }),
    movie("tt22", { releaseInfo: String(year + 1) }),
    movie("tt23", { releaseInfo: String(year) }),
    movie("tt24"),
  ];
  expect(
    filterCatalog(titles, [{ hideUnreleased: true }]).map((meta) => meta.id),
  ).toEqual(["tt20", "tt23", "tt24"]);
  expect(filterCatalog(titles, [{}])).toHaveLength(5);
});
