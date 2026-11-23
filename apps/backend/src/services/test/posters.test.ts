import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { describe, expect, it } from "vite-plus/test";
import { withAccountPosters } from "../posters";

function meta(id: string) {
  return {
    id,
    name: "Title",
    poster: "https://m.media-amazon.com/images/M/poster.jpg",
    posterShape: "poster",
    type: "movie",
    genres: [],
    description: "",
  } satisfies StremioMeta;
}

describe("withAccountPosters", () => {
  it("gives IMDb Titles the background that Stremio's Spotlight needs", async () => {
    const [served] = await withAccountPosters([meta("tt0133093")], {
      posterSource: "imdb",
      rpdbApiKey: null,
    });

    expect(served).toMatchObject({
      background:
        "https://images.metahub.space/background/medium/tt0133093/img",
      logo: "https://images.metahub.space/logo/medium/tt0133093/img",
      poster: "https://m.media-amazon.com/images/M/poster.jpg",
    });
  });

  it("gives no artwork to a meta without an IMDb ID", async () => {
    const [served] = await withAccountPosters(
      [meta("stremlist:unavailable:private")],
      { posterSource: "imdb", rpdbApiKey: null },
    );

    expect(served).not.toHaveProperty("background");
    expect(served).not.toHaveProperty("logo");
  });
});
