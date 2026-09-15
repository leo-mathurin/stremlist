import type {
  ConfigWatchlist,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../watchlist-cache",
  async () => import("../../__tests__/helpers/mock-watchlist-cache"),
);

import { cache } from "../../__tests__/helpers/mock-watchlist-cache";
import { filterCatalog, resolveCatalogSelection } from "../catalog-filters";
import { withAvailableGenres } from "../catalog-genres";
import { catalogSettingsSchema } from "../catalog-settings";
import { buildManifestCatalogs } from "../stremio-catalogs";

const watchlist: ConfigWatchlist = {
  id: "77e10eda-0e07-4c60-8ec7-23fb1b1d0573",
  imdbUserId: "ur12345678",
  catalogTitle: "Picks",
  sortOption: "added_at-asc",
  displayMode: "split",
  position: 0,
};
const movie: StremioMeta = {
  id: "tt1234567",
  name: "Example",
  type: "movie",
  poster: null,
  posterShape: "poster",
  description: "",
  genres: ["Drama", "New Genre", "Drama", ""],
};

beforeEach(() => {
  cache.reset();
});

describe("genres from cached IMDb titles", () => {
  it("deduplicates and sorts genres, exposes them in manifests, and accepts new genres as filters", async () => {
    cache.seed(watchlist.id, [
      movie,
      { ...movie, id: "tt7654321", type: "series", genres: ["Comedy"] },
    ]);
    const rows = await withAvailableGenres([watchlist]);
    expect(rows[0].availableGenres).toEqual(["Comedy", "Drama", "New Genre"]);
    for (const catalog of buildManifestCatalogs(rows)) {
      expect(
        catalog.extra?.find((extra) => extra.name === "genre")?.options,
      ).toEqual(expect.arrayContaining(["Comedy", "Drama", "New Genre"]));
    }
    const settings = catalogSettingsSchema.parse({ genre: "New Genre" });
    const selection = resolveCatalogSelection(
      watchlist.sortOption,
      settings,
      "New Genre",
    );
    expect(filterCatalog([movie], selection.filters)).toEqual([movie]);
  });

  it("limits choices to the watchlist's display mode", async () => {
    cache.seed(watchlist.id, [
      movie,
      { ...movie, id: "tt7654321", type: "series", genres: ["Comedy"] },
    ]);
    const rows = await withAvailableGenres([
      { ...watchlist, displayMode: "series" },
    ]);
    expect(rows[0].availableGenres).toEqual(["Comedy"]);
  });

  it("preserves saved genre selections without a cache and keeps lists independent", async () => {
    cache.seed(watchlist.id, [movie]);
    const rows = await withAvailableGenres([
      watchlist,
      {
        ...watchlist,
        id: "uncached",
        catalogSettings: { genre: "Western", presets: ["short"] },
      },
    ]);
    expect(rows[1].availableGenres).toEqual([]);
    expect(rows[1].catalogSettings?.genre).toBe("Western");
    for (const catalog of buildManifestCatalogs([rows[1]])) {
      const options = catalog.extra?.find(
        (extra) => extra.name === "genre",
      )?.options;
      expect(options).toContain("Western");
      expect(options).not.toContain("Drama");
    }
  });

  it.each(["", "   ", "a".repeat(101)])(
    "rejects invalid genre strings",
    (genre) => {
      expect(catalogSettingsSchema.safeParse({ genre }).success).toBe(false);
    },
  );
});
