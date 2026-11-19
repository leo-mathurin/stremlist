import { parseSortOption } from "@stremlist/shared/constants";
import { describe, expect, it } from "vite-plus/test";
import { movie } from "../../test/helpers/account.fixture";
import { sortCatalog } from "../catalog-sort";

const metas = [
  movie("tt1", {
    name: "Zulu",
    releaseInfo: "2020",
    released: "2020-03-01T00:00:00.000Z",
    imdbRating: "5",
  }),
  movie("tt2", {
    name: "Alpha",
    releaseInfo: "1990",
    released: "1990-06-01T00:00:00.000Z",
    imdbRating: "9.5",
  }),
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
    ["released-asc", ["tt2", "tt1", "tt3"]],
    ["released-desc", ["tt1", "tt2", "tt3"]],
  ])("applies %s without mutating canonical order", (option, ids) => {
    expect(
      sortCatalog(metas, parseSortOption(option), "generation").map(
        (meta) => meta.id,
      ),
    ).toEqual(ids);
    expect(metas.map((meta) => meta.id)).toEqual(["tt1", "tt2", "tt3"]);
  });
});

it("sorts an Up Next show by its latest episode, not its premiere", () => {
  const shows = [
    {
      ...movie("tt10", { released: "2008-01-20T00:00:00.000Z" }),
      type: "series" as const,
      latestEpisodeAt: "2013-09-29T00:00:00.000Z",
    },
    {
      ...movie("tt11", { released: "2025-06-04T00:00:00.000Z" }),
      type: "series" as const,
      latestEpisodeAt: "2026-11-18T02:00:00.000Z",
    },
    movie("tt12", { released: "2026-01-01T00:00:00.000Z" }),
  ];
  expect(
    sortCatalog(shows, parseSortOption("released-desc"), "generation").map(
      (meta) => meta.id,
    ),
  ).toEqual(["tt11", "tt12", "tt10"]);
});
