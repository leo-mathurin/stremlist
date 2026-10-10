import { describe, expect, it } from "vitest";
import { bucketOf, countNotFound, episodeItem, syncIds } from "../sync-payload";
import { toRating } from "../types";

describe("sync payloads", () => {
  it("name a Title by IMDb ID in its bucket", () => {
    const movie = { imdbId: "tt0111161", type: "movie" as const };
    const series = { imdbId: "tt0903747", type: "series" as const };
    expect(syncIds(movie)).toEqual({ imdb: "tt0111161" });
    expect(bucketOf(movie)).toBe("movies");
    expect(bucketOf(series)).toBe("shows");
  });

  it("name one episode of a show", () => {
    expect(
      episodeItem(
        { imdbId: "tt0903747", type: "series" },
        { season: 2, episode: 5 },
      ),
    ).toEqual({
      ids: { imdb: "tt0903747" },
      seasons: [{ number: 2, episodes: [{ number: 5 }] }],
    });
  });

  it("count not_found items as arrays or numbers", () => {
    expect(countNotFound(null)).toBe(0);
    expect(countNotFound({ added: { movies: 1 } })).toBe(0);
    expect(
      countNotFound({ not_found: { movies: [{}], shows: 2, people: [] } }),
    ).toBe(3);
  });

  it("count only the given keys when there are some", () => {
    expect(
      countNotFound({ not_found: { movies: [], seasons: [{}] } }, [
        "movies",
        "shows",
        "episodes",
      ]),
    ).toBe(0);
    expect(
      countNotFound({ not_found: { episodes: [{}] } }, [
        "movies",
        "shows",
        "episodes",
      ]),
    ).toBe(1);
  });
});

describe("toRating", () => {
  it("accepts integers from 1 to 10 only", () => {
    expect(toRating(1)).toBe(1);
    expect(toRating(10)).toBe(10);
    for (const value of [0, 11, 7.5, Number.NaN, "7", null, undefined]) {
      expect(toRating(value)).toBeNull();
    }
  });
});
