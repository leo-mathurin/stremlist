import { describe, expect, it } from "vitest";
import { buildCatalogId, parseCatalogId } from "../catalog-id";
import { buildManifestCatalogs } from "../stremio-catalogs";

function catalogsWithoutExtra(
  catalogs: ReturnType<typeof buildManifestCatalogs>,
) {
  return catalogs.map(({ id, name, type }) => ({ id, name, type }));
}

describe("catalog id helpers", () => {
  it("builds and parses movie ids", () => {
    const watchlistId = "77e10eda-0e07-4c60-8ec7-23fb1b1d0573";
    const catalogId = buildCatalogId(watchlistId, "movie");

    expect(catalogId).toBe("wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie");
    expect(parseCatalogId(catalogId)).toEqual({ watchlistId, type: "movie" });
  });

  it("rejects malformed ids", () => {
    expect(parseCatalogId("stremlist-movies")).toBeNull();
    expect(parseCatalogId("wl-not-a-uuid-series")).toBeNull();
    expect(
      parseCatalogId("wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-anime"),
    ).toBeNull();
  });
});

describe("manifest catalog generation", () => {
  it("creates movie and series catalogs for each watchlist title", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "Leo Picks",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      },
      {
        id: "3be4e39f-3e27-42e7-a69f-c14f0709de52",
        imdbUserId: "ur87654321",
        catalogTitle: "Family Queue",
        sortOption: "title-asc",
        displayMode: "split",
        position: 1,
      },
    ]);

    expect(
      catalogs.every((catalog) => catalog.extra?.[0]?.name === "skip"),
    ).toBe(true);
    for (const catalog of catalogs) {
      const genre = catalog.extra?.find((extra) => extra.name === "genre");
      expect(genre?.isRequired).toBe(false);
      expect(genre?.optionsLimit).toBe(1);
      expect(genre?.options).toEqual(
        expect.arrayContaining([
          "Comedy",
          "1990s",
          "Shuffle",
          "Shortest",
          "IMDb Rating (Highest)",
        ]),
      );
    }
    expect(catalogsWithoutExtra(catalogs)).toEqual([
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie",
        name: "Stremlist Leo Picks",
        type: "movie",
      },
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-series",
        name: "Stremlist Leo Picks",
        type: "series",
      },
      {
        id: "wl-3be4e39f-3e27-42e7-a69f-c14f0709de52-movie",
        name: "Stremlist Family Queue",
        type: "movie",
      },
      {
        id: "wl-3be4e39f-3e27-42e7-a69f-c14f0709de52-series",
        name: "Stremlist Family Queue",
        type: "series",
      },
    ]);
  });

  it("exposes enabled presets on the home and keeps search on the base catalog", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "Picks",
        sortOption: "title-asc",
        displayMode: "movie",
        position: 0,
        catalogSettings: { presets: ["short", "rated", "shuffle"] },
      },
    ]);
    expect(catalogs.map((catalog) => catalog.id)).toEqual([
      "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie",
      "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie--short",
      "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie--rated",
      "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie--shuffle",
    ]);
    expect(catalogs[0].extra?.some((extra) => extra.name === "search")).toBe(
      true,
    );
    expect(
      catalogs
        .slice(1)
        .every(
          (catalog) => !catalog.extra?.some((extra) => extra.name === "search"),
        ),
    ).toBe(true);
    expect(parseCatalogId(catalogs[1].id)).toEqual({
      watchlistId: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
      type: "movie",
      preset: "short",
    });
    expect(parseCatalogId(`${catalogs[0].id}--unknown`)).toBeNull();
  });

  it("uses base Stremlist title when catalog title is empty", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      },
    ]);

    expect(catalogsWithoutExtra(catalogs)).toEqual([
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie",
        name: "Stremlist",
        type: "movie",
      },
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-series",
        name: "Stremlist",
        type: "series",
      },
    ]);
  });

  it("defaults unnamed watchlists to numeric titles when multiple exist", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      },
      {
        id: "3be4e39f-3e27-42e7-a69f-c14f0709de52",
        imdbUserId: "ur87654321",
        catalogTitle: "",
        sortOption: "title-asc",
        displayMode: "split",
        position: 1,
      },
    ]);

    expect(catalogsWithoutExtra(catalogs)).toEqual([
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie",
        name: "Stremlist 1",
        type: "movie",
      },
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-series",
        name: "Stremlist 1",
        type: "series",
      },
      {
        id: "wl-3be4e39f-3e27-42e7-a69f-c14f0709de52-movie",
        name: "Stremlist 2",
        type: "movie",
      },
      {
        id: "wl-3be4e39f-3e27-42e7-a69f-c14f0709de52-series",
        name: "Stremlist 2",
        type: "series",
      },
    ]);
  });

  it("emits only the movie catalog when displayMode is movie", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "Leo Picks",
        sortOption: "added_at-asc",
        displayMode: "movie",
        position: 0,
      },
    ]);

    expect(catalogsWithoutExtra(catalogs)).toEqual([
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie",
        name: "Stremlist Leo Picks",
        type: "movie",
      },
    ]);
  });

  it("emits only the series catalog when displayMode is series", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "Leo Picks",
        sortOption: "added_at-asc",
        displayMode: "series",
        position: 0,
      },
    ]);

    expect(catalogsWithoutExtra(catalogs)).toEqual([
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-series",
        name: "Stremlist Leo Picks",
        type: "series",
      },
    ]);
  });

  it("defaults to both catalogs for an unknown displayMode", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "Leo Picks",
        sortOption: "added_at-asc",
        displayMode: "bogus" as never,
        position: 0,
      },
    ]);

    expect(catalogsWithoutExtra(catalogs)).toEqual([
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-movie",
        name: "Stremlist Leo Picks",
        type: "movie",
      },
      {
        id: "wl-77e10eda-0e07-4c60-8ec7-23fb1b1d0573-series",
        name: "Stremlist Leo Picks",
        type: "series",
      },
    ]);
  });
});
