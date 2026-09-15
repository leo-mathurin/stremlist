import { parseSortOption } from "@stremlist/shared/constants";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, expect, it } from "vitest";
import { sortWatchlist } from "../watchlist-sort";

const metas: StremioMeta[] = [
  { id: "tt1", name: "Zulu", releaseInfo: "2020", imdbRating: "5" },
  { id: "tt2", name: "Alpha", releaseInfo: "1990", imdbRating: "9.5" },
  { id: "tt3", name: "Mango", releaseInfo: "2005", imdbRating: "7" },
].map((meta) => ({
  ...meta,
  type: "movie",
  poster: null,
  posterShape: "poster",
  genres: [],
  description: "",
}));

describe("watchlist sorting", () => {
  it.each([
    ["added_at-asc", ["tt1", "tt2", "tt3"]],
    ["added_at-desc", ["tt3", "tt2", "tt1"]],
    ["title-asc", ["tt2", "tt3", "tt1"]],
    ["title-desc", ["tt1", "tt3", "tt2"]],
    ["year-asc", ["tt2", "tt3", "tt1"]],
    ["year-desc", ["tt1", "tt3", "tt2"]],
    ["rating-asc", ["tt1", "tt3", "tt2"]],
    ["rating-desc", ["tt2", "tt3", "tt1"]],
  ])("applies %s without mutating canonical order", (option, ids) => {
    expect(
      sortWatchlist(metas, parseSortOption(option), "generation").map(
        (meta) => meta.id,
      ),
    ).toEqual(ids);
    expect(metas.map((meta) => meta.id)).toEqual(["tt1", "tt2", "tt3"]);
  });
});
