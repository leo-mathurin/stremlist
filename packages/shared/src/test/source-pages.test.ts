import { describe, expect, it } from "vite-plus/test";
import { sourcePageUrl } from "../source-pages";

describe("sourcePageUrl", () => {
  it("uses the known page of a chart", () => {
    expect(sourcePageUrl("imdb", "imdb:top-rated-movies", null)).toBe(
      "https://www.imdb.com/chart/top/",
    );
  });

  it("links a Trakt user's pages and own lists", () => {
    expect(sourcePageUrl("trakt", "me/watchlist", "movie buff")).toBe(
      "https://trakt.tv/users/movie%20buff/watchlist",
    );
    expect(sourcePageUrl("trakt", "me/up-next", "moviebuff")).toBe(
      "https://trakt.tv/users/moviebuff/progress",
    );
    expect(sourcePageUrl("trakt", "me/lists/date-night", "moviebuff")).toBe(
      "https://trakt.tv/users/moviebuff/lists/date-night",
    );
  });

  it("links the Trakt pages that need no username", () => {
    expect(sourcePageUrl("trakt", "me/recommendations", null)).toBe(
      "https://trakt.tv/movies/recommendations",
    );
    expect(sourcePageUrl("trakt", "calendars/all/shows/new", null)).toBe(
      "https://app.trakt.tv/calendar",
    );
  });

  it("has no page for a user's lists without a username", () => {
    expect(sourcePageUrl("trakt", "me/watchlist", null)).toBeUndefined();
  });

  it("links MDBList charts and own lists, not a user's watchlist", () => {
    expect(sourcePageUrl("mdblist", "official/trending", null)).toBe(
      "https://mdblist.com/toplists",
    );
    expect(sourcePageUrl("mdblist", "me/lists/101", "moviebuff")).toBe(
      "https://mdblist.com/lists/moviebuff",
    );
    expect(
      sourcePageUrl("mdblist", "me/watchlist", "moviebuff"),
    ).toBeUndefined();
  });

  it("has no page for Simkl library lists", () => {
    expect(
      sourcePageUrl("simkl", "me/plantowatch", "moviebuff"),
    ).toBeUndefined();
  });
});
