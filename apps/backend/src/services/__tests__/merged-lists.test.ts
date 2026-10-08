import {
  MAX_SOURCES_PER_LIST,
  allowedDisplayModes,
  connectionProviders,
  isSortAllowed,
  listMergeProblem,
  listRequiresConnection,
  mergesByAddedDate,
  singleTypeReason,
  sourceHasAddedDates,
  sourceTitleType,
} from "@stremlist/shared/list-merge";
import type { ListSource } from "@stremlist/shared/list-merge";
import { describe, expect, it } from "vitest";
import { movie } from "../../__tests__/helpers/fixtures";
import type { SourceMeta } from "../list-cache";
import {
  mergeSourceCatalogs,
  sourceCaches,
  toStremioMeta,
  unusedSourceCaches,
} from "../merged-lists";

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const WATCHLIST: ListSource = { provider: "imdb", sourceRef: "ur12345678" };
const TRAKT: ListSource = {
  provider: "trakt",
  sourceRef: "users/sean/watchlist",
};
const TOP_MOVIES: ListSource = {
  provider: "imdb",
  sourceRef: "imdb:top-rated-movies",
};
const TOP_TV: ListSource = { provider: "imdb", sourceRef: "imdb:top-rated-tv" };

function merged(
  first: ListSource,
  others: ListSource[],
  overrides: { displayMode?: "split" | "movie" | "series"; sort?: string } = {},
) {
  return {
    ...first,
    mergedSources: others,
    displayMode: overrides.displayMode ?? "split",
    sortOption: overrides.sort ?? "title-asc",
  };
}

function dated(id: string, addedAt?: string, description = ""): SourceMeta {
  return { ...movie(id, { description }), ...(addedAt ? { addedAt } : {}) };
}

describe("merge rules", () => {
  it("accepts a List with one Source list whatever its sort", () => {
    expect(
      listMergeProblem({
        ...TOP_MOVIES,
        displayMode: "series",
        sortOption: "added_at-desc",
      }),
    ).toBeNull();
  });

  it(`merges at most ${MAX_SOURCES_PER_LIST} Source lists`, () => {
    const others = Array.from({ length: MAX_SOURCES_PER_LIST }, (_, i) => ({
      provider: "imdb" as const,
      sourceRef: `ls${i + 1}`,
    }));
    expect(listMergeProblem(merged(WATCHLIST, others.slice(0, -1)))).toBeNull();
    expect(listMergeProblem(merged(WATCHLIST, others))).toBe(
      `A List can merge at most ${MAX_SOURCES_PER_LIST} Source lists.`,
    );
  });

  it("refuses the same Source list twice", () => {
    expect(listMergeProblem(merged(WATCHLIST, [TRAKT, WATCHLIST]))).toBe(
      "Each list can only be added once.",
    );
  });

  it("keeps every Title type of single-type Source lists", () => {
    expect(sourceTitleType("imdb", TOP_MOVIES.sourceRef)).toBe("movie");
    expect(sourceTitleType("trakt", "me/up-next")).toBe("series");
    expect(sourceTitleType("imdb", WATCHLIST.sourceRef)).toBeNull();

    expect(allowedDisplayModes(merged(WATCHLIST, [TOP_MOVIES]))).toEqual([
      "split",
      "movie",
    ]);
    expect(allowedDisplayModes(merged(TOP_MOVIES, [TOP_TV]))).toEqual([
      "split",
    ]);
    expect(
      listMergeProblem(
        merged(WATCHLIST, [TOP_MOVIES], { displayMode: "series" }),
      ),
    ).toBe(
      "Top 250 Movies has only movies, so this List cannot show only TV shows.",
    );
    expect(
      listMergeProblem(merged(TOP_MOVIES, [TOP_TV], { displayMode: "movie" })),
    ).toBe(
      "Top 250 Movies has only movies and Top 250 TV Shows has only TV shows, so this List must show movies and TV shows.",
    );
    expect(
      listMergeProblem(
        merged(WATCHLIST, [TOP_MOVIES], { displayMode: "movie" }),
      ),
    ).toBeNull();
  });

  it("sorts by date added only when every Source list gives dates", () => {
    expect(sourceHasAddedDates("imdb", "ur12345678")).toBe(true);
    expect(sourceHasAddedDates("imdb", "ls055592025")).toBe(true);
    expect(sourceHasAddedDates("imdb", "imdb:top-rated-movies")).toBe(false);
    expect(sourceHasAddedDates("trakt", "users/sean/lists/picks")).toBe(true);
    expect(sourceHasAddedDates("trakt", "me/history")).toBe(true);
    expect(sourceHasAddedDates("trakt", "trending")).toBe(false);
    expect(sourceHasAddedDates("trakt", "me/recommendations")).toBe(false);
    expect(sourceHasAddedDates("simkl", "me/plantowatch")).toBe(true);
    expect(sourceHasAddedDates("simkl", "me/lists/12")).toBe(false);
    expect(sourceHasAddedDates("mdblist", "me/watchlist")).toBe(true);
    expect(sourceHasAddedDates("mdblist", "lists/12")).toBe(false);
    expect(sourceHasAddedDates("justwatch", "tl-us-1")).toBe(false);
    expect(sourceHasAddedDates("senscritique", "users/leo/wishes")).toBe(false);

    expect(
      listMergeProblem(merged(WATCHLIST, [TRAKT], { sort: "added_at-desc" })),
    ).toBeNull();
    expect(
      listMergeProblem(
        merged(
          WATCHLIST,
          [TOP_MOVIES, { provider: "trakt", sourceRef: "popular" }],
          {
            sort: "added_at-asc",
          },
        ),
      ),
    ).toBe(
      "Top 250 Movies and Trakt Popular do not give the date when each Title was added, so this List cannot sort by date added.",
    );
    expect(
      listMergeProblem(
        merged(WATCHLIST, [{ provider: "justwatch", sourceRef: "tl-us-1" }], {
          sort: "added_at-asc",
        }),
      ),
    ).toBe(
      "The JustWatch list does not give the date when each Title was added, so this List cannot sort by date added.",
    );
  });

  it("needs a Connection when any Source list needs one", () => {
    expect(listRequiresConnection(merged(WATCHLIST, [TRAKT]))).toBe(false);
    expect(
      listRequiresConnection(
        merged(WATCHLIST, [{ provider: "trakt", sourceRef: "me/watchlist" }]),
      ),
    ).toBe(true);
    expect(
      connectionProviders(
        merged({ provider: "trakt", sourceRef: "me/watchlist" }, [
          WATCHLIST,
          { provider: "trakt", sourceRef: "me/history" },
          { provider: "simkl", sourceRef: "me/plantowatch" },
        ]),
      ),
    ).toEqual(["trakt", "simkl"]);
  });

  it("explains single-type Source lists only for merged Lists", () => {
    expect(singleTypeReason(TOP_MOVIES)).toBeNull();
    expect(singleTypeReason(merged(WATCHLIST, [TRAKT]))).toBeNull();
    expect(
      singleTypeReason(
        merged(TOP_MOVIES, [
          { provider: "imdb", sourceRef: "imdb:most-popular-movies" },
          TOP_TV,
        ]),
      ),
    ).toMatch(/ have only movies and Top 250 TV Shows has only TV shows$/);
  });

  it("merges by date added only a merged List whose Source lists all give dates", () => {
    expect(mergesByAddedDate(WATCHLIST)).toBe(false);
    expect(mergesByAddedDate(merged(WATCHLIST, [TRAKT]))).toBe(true);
    expect(mergesByAddedDate(merged(WATCHLIST, [TOP_MOVIES]))).toBe(false);
    expect(isSortAllowed(TOP_MOVIES, "added_at-asc")).toBe(true);
    expect(isSortAllowed(merged(WATCHLIST, [TOP_MOVIES]), "added_at-asc")).toBe(
      false,
    );
    expect(isSortAllowed(merged(WATCHLIST, [TOP_MOVIES]), "title-asc")).toBe(
      true,
    );
  });
});

describe("source caches", () => {
  it("keeps the List ID for a List with one Source list", () => {
    expect(sourceCaches({ id: LIST_ID, ...WATCHLIST })).toEqual([
      { source: WATCHLIST, cacheKey: LIST_ID },
    ]);
  });

  it("gives each Source list of a merged List its own stable key", () => {
    const keys = sourceCaches({
      id: LIST_ID,
      ...WATCHLIST,
      mergedSources: [TRAKT],
    });
    const reordered = sourceCaches({
      id: LIST_ID,
      ...TRAKT,
      mergedSources: [WATCHLIST],
    });
    expect(keys.map((key) => key.source)).toEqual([WATCHLIST, TRAKT]);
    expect(
      keys.every((key) => key.cacheKey.startsWith(`${LIST_ID}/sources/`)),
    ).toBe(true);
    expect(new Set(keys.map((key) => key.cacheKey)).size).toBe(2);
    expect(reordered.map((key) => key.cacheKey)).toEqual(
      [...keys].reverse().map((key) => key.cacheKey),
    );
  });

  it("finds the caches that a save stopped using", () => {
    const single = { id: LIST_ID, ...WATCHLIST };
    const both = { ...single, mergedSources: [TRAKT] };
    const [watchlistKey, traktKey] = sourceCaches(both).map(
      (key) => key.cacheKey,
    );

    // Merging: the List ID cache belonged to the single Source list.
    expect(unusedSourceCaches([single], [both])).toEqual([LIST_ID]);
    // Removing one Source list drops only its cache.
    expect(
      unusedSourceCaches(
        [{ ...both, mergedSources: [TRAKT, TOP_MOVIES] }],
        [both],
      ),
    ).toEqual([
      sourceCaches({ ...both, mergedSources: [TRAKT, TOP_MOVIES] })[2].cacheKey,
    ]);
    // Back to one Source list: both merged caches go.
    expect(unusedSourceCaches([both], [single])).toEqual([
      watchlistKey,
      traktKey,
    ]);
    // A List whose single Source list changed loses the List ID cache.
    expect(unusedSourceCaches([single], [{ id: LIST_ID, ...TRAKT }])).toEqual([
      LIST_ID,
    ]);
    // Unchanged Lists and removed Lists.
    expect(unusedSourceCaches([both], [both])).toEqual([]);
    expect(unusedSourceCaches([single], [])).toEqual([LIST_ID]);
  });
});

describe("mergeSourceCatalogs", () => {
  it("shows each Title once, by IMDb ID, in the List's order without dates", () => {
    const result = mergeSourceCatalogs(
      [
        [dated("tt1"), dated("tt2")],
        [dated("tt3"), dated("tt1"), dated("tt4")],
      ],
      false,
    );
    expect(result.map((meta) => meta.id)).toEqual(["tt1", "tt2", "tt3", "tt4"]);
  });

  it("sorts Source lists together by date added and keeps the first date", () => {
    const result = mergeSourceCatalogs(
      [
        [
          dated("tt1", "2020-01-01T00:00:00.000Z"),
          dated("tt2", "2023-01-01T00:00:00.000Z"),
        ],
        [
          dated("tt3", "2021-06-01T00:00:00.000Z"),
          dated("tt1", "2024-01-01T00:00:00.000Z"),
          dated("tt4", "2025-01-01T00:00:00.000Z"),
        ],
      ],
      true,
    );
    expect(result.map((meta) => [meta.id, meta.addedAt])).toEqual([
      ["tt1", "2020-01-01T00:00:00.000Z"],
      ["tt3", "2021-06-01T00:00:00.000Z"],
      ["tt2", "2023-01-01T00:00:00.000Z"],
      ["tt4", "2025-01-01T00:00:00.000Z"],
    ]);
  });

  it("puts Titles without a date first, in their Source list order", () => {
    const result = mergeSourceCatalogs(
      [
        [dated("tt1", "2020-01-01T00:00:00.000Z"), dated("tt2")],
        [dated("tt3")],
      ],
      true,
    );
    expect(result.map((meta) => meta.id)).toEqual(["tt2", "tt3", "tt1"]);
  });

  it("keeps the link back of a duplicate from another Provider", () => {
    const result = mergeSourceCatalogs(
      [
        [dated("tt1", undefined, "A plot.")],
        [
          dated(
            "tt1",
            undefined,
            "A plot.\n\nMore on Simkl: https://simkl.com/movies/1/a",
          ),
        ],
        [
          dated(
            "tt1",
            undefined,
            "A plot.\n\nMore on Simkl: https://simkl.com/movies/1/a",
          ),
        ],
      ],
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe(
      "A plot.\n\nMore on Simkl: https://simkl.com/movies/1/a",
    );
  });

  it("never serves the date added to Stremio", () => {
    const meta = dated("tt1", "2020-01-01T00:00:00.000Z");
    expect(toStremioMeta(meta)).toEqual(movie("tt1"));
    expect(meta.addedAt).toBe("2020-01-01T00:00:00.000Z");
  });
});
