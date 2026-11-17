import { describe, expect, it } from "vite-plus/test";
import { choosePoster } from "../poster";

const IMDB = "https://m.media-amazon.com/images/M/poster.jpg";
const TMDB = "https://image.tmdb.org/t/p/w500/poster.jpg";
const RPDB =
  "https://api.ratingposterdb.com/key/imdb/poster-default/tt0111161.jpg?fallback=true";

describe("choosePoster", () => {
  it("shows the IMDb poster by default, even when TMDB has one", () => {
    expect(
      choosePoster(
        "tt0111161",
        { imdb: IMDB, tmdb: TMDB },
        { posterSource: "imdb" },
      ),
    ).toBe(IMDB);
  });

  it("shows the TMDB poster when the Account chose TMDB", () => {
    expect(
      choosePoster(
        "tt0111161",
        { imdb: IMDB, tmdb: TMDB },
        { posterSource: "tmdb" },
      ),
    ).toBe(TMDB);
  });

  it("falls back to the IMDb poster when TMDB has none", () => {
    for (const tmdb of [null, undefined]) {
      expect(
        choosePoster(
          "tt0111161",
          { imdb: IMDB, tmdb },
          { posterSource: "tmdb" },
        ),
      ).toBe(IMDB);
    }
  });

  it("lets an RPDB key replace both sources", () => {
    for (const posterSource of ["imdb", "tmdb"] as const) {
      expect(
        choosePoster(
          "tt0111161",
          { imdb: IMDB, tmdb: TMDB },
          { posterSource, rpdbApiKey: " key " },
        ),
      ).toBe(RPDB);
    }
  });
});
