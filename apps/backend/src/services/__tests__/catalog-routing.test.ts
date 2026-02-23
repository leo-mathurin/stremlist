import { describe, expect, it } from "vitest";
import { buildCatalogId, parseCatalogId } from "../catalog-id";
import { buildManifestCatalogs } from "../stremio-catalogs";

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
        position: 0,
      },
      {
        id: "3be4e39f-3e27-42e7-a69f-c14f0709de52",
        imdbUserId: "ur87654321",
        catalogTitle: "Family Queue",
        sortOption: "title-asc",
        position: 1,
      },
    ]);

    expect(catalogs).toEqual([
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

  it("uses base Stremlist title when catalog title is empty", () => {
    const catalogs = buildManifestCatalogs([
      {
        id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
        imdbUserId: "ur12345678",
        catalogTitle: "",
        sortOption: "added_at-asc",
        position: 0,
      },
    ]);

    expect(catalogs).toEqual([
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
        position: 0,
      },
      {
        id: "3be4e39f-3e27-42e7-a69f-c14f0709de52",
        imdbUserId: "ur87654321",
        catalogTitle: "",
        sortOption: "title-asc",
        position: 1,
      },
    ]);

    expect(catalogs).toEqual([
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
});
