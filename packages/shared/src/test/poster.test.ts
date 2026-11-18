import { describe, expect, it } from "vite-plus/test";
import { choosePoster } from "../poster";

const IMDB = "https://m.media-amazon.com/images/M/poster.jpg";
const TMDB = "https://image.tmdb.org/t/p/w500/poster.jpg";
const TVDB = "https://artworks.thetvdb.com/banners/posters/poster.jpg";
const RPDB =
  "https://api.ratingposterdb.com/key/imdb/poster-default/tt0111161.jpg?fallback=true";
const BOTH = { imdb: IMDB, tmdb: TMDB };

describe("choosePoster", () => {
  it("shows the IMDb poster by default, even with a TMDB poster and a key", () => {
    expect(
      choosePoster("tt0111161", BOTH, {
        posterSource: "imdb",
        rpdbApiKey: "key",
      }),
    ).toBe(IMDB);
  });

  it("shows the TMDB poster, and the IMDb one when TMDB has none", () => {
    expect(
      choosePoster("tt0111161", BOTH, {
        posterSource: "tmdb",
        rpdbApiKey: "key",
      }),
    ).toBe(TMDB);
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

  it("shows the TheTVDB poster, and the IMDb one when TheTVDB has none", () => {
    expect(
      choosePoster(
        "tt0111161",
        { ...BOTH, tvdb: TVDB },
        { posterSource: "tvdb", rpdbApiKey: "key" },
      ),
    ).toBe(TVDB);
    expect(choosePoster("tt0111161", BOTH, { posterSource: "tvdb" })).toBe(
      IMDB,
    );
  });

  it("shows the RPDB poster with a key, and the IMDb one without", () => {
    expect(
      choosePoster("tt0111161", BOTH, {
        posterSource: "rpdb",
        rpdbApiKey: " key ",
      }),
    ).toBe(RPDB);
    for (const rpdbApiKey of [null, undefined, "", "  "]) {
      expect(
        choosePoster("tt0111161", BOTH, { posterSource: "rpdb", rpdbApiKey }),
      ).toBe(IMDB);
    }
  });
});
