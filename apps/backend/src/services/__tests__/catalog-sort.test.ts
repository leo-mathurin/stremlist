import { parseSortOption } from "@stremlist/shared/constants";
import { describe, expect, it } from "vitest";
import { movie } from "../../__tests__/helpers/fixtures";
import { sortCatalog } from "../catalog-sort";

const metas = [
  movie("tt1", { name: "Zulu", releaseInfo: "2020", imdbRating: "5" }),
  movie("tt2", { name: "Alpha", releaseInfo: "1990", imdbRating: "9.5" }),
  movie("tt3", { name: "Mango", releaseInfo: "2005", imdbRating: "7" }),
];

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
      sortCatalog(metas, parseSortOption(option), "generation").map(
        (meta) => meta.id,
      ),
    ).toEqual(ids);
    expect(metas.map((meta) => meta.id)).toEqual(["tt1", "tt2", "tt3"]);
  });
});
