import { describe, expect, it } from "vite-plus/test";
import { sourcePageUrl } from "../source-pages";

describe("sourcePageUrl", () => {
  it("uses the known page of a chart", () => {
    expect(sourcePageUrl("imdb", "imdb:top-rated-movies", null)).toBe(
      "https://www.imdb.com/chart/top/",
    );
  });

  it("links a Trakt user's pages with me, not the username", () => {
    expect(sourcePageUrl("trakt", "me/watchlist", "movie_buff")).toBe(
      "https://app.trakt.tv/users/me/watchlist",
    );
    expect(sourcePageUrl("trakt", "me/up-next", null)).toBe(
      "https://app.trakt.tv/users/me/progress",
    );
    expect(sourcePageUrl("trakt", "me/continue-watching", null)).toBe(
      "https://app.trakt.tv/users/me/progress",
    );
    expect(sourcePageUrl("trakt", "me/lists/date-night", null)).toBe(
      "https://app.trakt.tv/users/me/lists/date-night",
    );
  });

  it("has no page for a Trakt collection", () => {
    expect(
      sourcePageUrl("trakt", "me/collection", "moviebuff"),
    ).toBeUndefined();
  });

  it("links the Trakt pages of every user", () => {
    expect(sourcePageUrl("trakt", "me/recommendations", null)).toBe(
      "https://app.trakt.tv/discover/recommended",
    );
    expect(sourcePageUrl("trakt", "calendars/all/shows/new", null)).toBe(
      "https://app.trakt.tv/calendar",
    );
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
