import type { ConfigList } from "@stremlist/shared/stremio.types";
import { describe, expect, it } from "vitest";
import { buildCatalogId, parseCatalogId } from "../catalog-id";
import { buildManifestCatalogs } from "../stremio-catalogs";

const FIRST = "77e10eda-0e07-4c60-8ec7-23fb1b1d0573";
const SECOND = "3be4e39f-3e27-42e7-a69f-c14f0709de52";

function list(overrides: Partial<ConfigList> = {}): ConfigList {
  return {
    id: FIRST,
    provider: "imdb",
    sourceRef: "ur12345678",
    catalogTitle: "Leo Picks",
    sortOption: "added_at-asc",
    displayMode: "split",
    position: 0,
    ...overrides,
  };
}

const second = (overrides: Partial<ConfigList> = {}) =>
  list({ id: SECOND, sourceRef: "ur87654321", position: 1, ...overrides });

function catalogsWithoutExtra(lists: ConfigList[]) {
  return buildManifestCatalogs(lists).map(({ id, name, type }) => ({
    id,
    name,
    type,
  }));
}

/** The expected movie and series catalogs of a List. */
function both(listId: string, name: string) {
  return (["movie", "series"] as const).map((type) => ({
    id: `wl-${listId}-${type}`,
    name,
    type,
  }));
}

describe("catalog id helpers", () => {
  it("builds and parses movie ids", () => {
    const catalogId = buildCatalogId(FIRST, "movie");

    expect(catalogId).toBe(`wl-${FIRST}-movie`);
    expect(parseCatalogId(catalogId)).toEqual({
      kind: "list",
      listId: FIRST,
      type: "movie",
    });
  });

  it("rejects malformed ids", () => {
    expect(parseCatalogId("stremlist-movies")).toBeNull();
    expect(parseCatalogId("wl-not-a-uuid-series")).toBeNull();
    expect(parseCatalogId(`wl-${FIRST}-anime`)).toBeNull();
  });
});

describe("manifest catalog generation", () => {
  it("creates movie and series catalogs for each List title", () => {
    const lists = [
      list({ availableGenres: ["Comedy"] }),
      second({
        catalogTitle: "Family Queue",
        availableGenres: ["Comedy"],
        sortOption: "title-asc",
      }),
    ];
    const catalogs = buildManifestCatalogs(lists);

    for (const catalog of catalogs) {
      expect(catalog.extra?.[0]?.name).toBe("skip");
      const genre = catalog.extra?.find((extra) => extra.name === "genre");
      expect(genre?.isRequired).toBe(false);
      expect(genre?.optionsLimit).toBe(1);
      expect(genre?.options).toEqual(
        expect.arrayContaining([
          "1990s",
          "Shuffle",
          "Shortest",
          "IMDb Rating (Highest)",
        ]),
      );
    }
    expect(catalogsWithoutExtra(lists)).toEqual([
      ...both(FIRST, "Stremlist Leo Picks"),
      ...both(SECOND, "Stremlist Family Queue"),
    ]);
  });

  it("exposes enabled presets on the home and keeps search on the base catalog", () => {
    const catalogs = buildManifestCatalogs([
      list({
        catalogTitle: "Picks",
        sortOption: "title-asc",
        displayMode: "movie",
        catalogSettings: { presets: ["short", "rated", "shuffle"] },
      }),
    ]);
    const hasSearch = (catalog: (typeof catalogs)[number]) =>
      catalog.extra?.some((extra) => extra.name === "search");
    expect(catalogs.map((catalog) => catalog.id)).toEqual([
      `wl-${FIRST}-movie`,
      `wl-${FIRST}-movie--short`,
      `wl-${FIRST}-movie--rated`,
      `wl-${FIRST}-movie--shuffle`,
    ]);
    expect(hasSearch(catalogs[0])).toBe(true);
    expect(catalogs.slice(1).some(hasSearch)).toBe(false);
    expect(parseCatalogId(catalogs[1].id)).toEqual({
      kind: "list",
      listId: FIRST,
      type: "movie",
      preset: "short",
    });
    expect(parseCatalogId(`${catalogs[0].id}--unknown`)).toBeNull();
  });

  it("uses base Stremlist title when catalog title is empty", () => {
    expect(catalogsWithoutExtra([list({ catalogTitle: "" })])).toEqual(
      both(FIRST, "Stremlist"),
    );
  });

  it("defaults unnamed Lists to numeric titles when multiple exist", () => {
    expect(
      catalogsWithoutExtra([
        list({ catalogTitle: "" }),
        second({ catalogTitle: "", sortOption: "title-asc" }),
      ]),
    ).toEqual([...both(FIRST, "Stremlist 1"), ...both(SECOND, "Stremlist 2")]);
  });

  it.each([
    ["only the movie catalog when displayMode is movie", "movie", ["movie"]],
    [
      "only the series catalog when displayMode is series",
      "series",
      ["series"],
    ],
    ["both catalogs for an unknown displayMode", "bogus", ["movie", "series"]],
  ])("emits %s", (_case, displayMode, types) => {
    expect(
      catalogsWithoutExtra([list({ displayMode: displayMode as never })]),
    ).toEqual(
      both(FIRST, "Stremlist Leo Picks").filter((catalog) =>
        types.includes(catalog.type),
      ),
    );
  });
});
