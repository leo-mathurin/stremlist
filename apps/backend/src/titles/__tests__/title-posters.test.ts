import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { db } from "../../__tests__/helpers/mock-supabase";
import { MockQueryBuilder } from "../../__tests__/helpers/supabase/query-builder";
import { findPosters, resetPosterMemory } from "../title-posters";
import { resetTvdbToken } from "../tvdb";

vi.mock(
  "../../lib/supabase",
  () => import("../../__tests__/helpers/mock-supabase"),
);

const BOTH = {
  movie_results: [{ poster_path: "/as-movie.jpg" }],
  tv_results: [{ poster_path: "/as-show.jpg" }],
};

function answer(body: unknown, delayMs = 0) {
  return vi.fn(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(Response.json(body)), delayMs),
      ),
  );
}

beforeEach(() => {
  db.reset();
  resetPosterMemory();
  resetTvdbToken();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("findPosters on TMDB", () => {
  it("takes the TMDB result of the Title's type first", async () => {
    vi.stubGlobal("fetch", answer(BOTH));
    const posters = await findPosters(
      "tmdb",
      [
        { id: "tt0000001", type: "movie" },
        { id: "tt0000002", type: "series" },
      ],
      { budgetMs: 1000, size: "preview" },
    );
    expect(Object.fromEntries(posters)).toEqual({
      tt0000001: "https://image.tmdb.org/t/p/w342/as-movie.jpg",
      tt0000002: "https://image.tmdb.org/t/p/w342/as-show.jpg",
    });
  });

  it("ignores IDs that are not IMDb Title IDs and unsafe image paths", async () => {
    const fetch = answer({ movie_results: [{ poster_path: "../x?y" }] });
    vi.stubGlobal("fetch", fetch);
    const posters = await findPosters(
      "tmdb",
      [
        { id: "stremlist:unavailable:private", type: "movie" },
        { id: "tt0000003", type: "movie" },
      ],
      { budgetMs: 1000, size: "stremio" },
    );
    expect(posters.size).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps its budget when the stored posters are slow to read", async () => {
    const fetch = answer(BOTH);
    vi.stubGlobal("fetch", fetch);
    const read = vi
      .spyOn(MockQueryBuilder.prototype, "then")
      .mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    const posters = await findPosters(
      "tmdb",
      [{ id: "tt0000009", type: "movie" }],
      { budgetMs: 50, size: "stremio" },
    );
    expect(posters.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetch).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("asks TMDB once for a Title that concurrent requests need", async () => {
    const fetch = answer(BOTH, 20);
    vi.stubGlobal("fetch", fetch);
    const title = { id: "tt0000010", type: "movie" as const };
    const [first, second] = await Promise.all([
      findPosters("tmdb", [title], { budgetMs: 1000, size: "stremio" }),
      findPosters("tmdb", [title], { budgetMs: 1000, size: "stremio" }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(first.get(title.id)).toBe(
      "https://image.tmdb.org/t/p/w500/as-movie.jpg",
    );
    expect(second.get(title.id)).toBe(first.get(title.id));
  });

  it("answers within its budget and stores late answers for the next call", async () => {
    vi.stubGlobal("fetch", answer(BOTH, 200));
    const title = { id: "tt0000004", type: "movie" as const };

    const first = await findPosters("tmdb", [title], {
      budgetMs: 10,
      size: "stremio",
    });
    expect(first.size).toBe(0);

    await vi.waitFor(() => {
      expect(db.getTable("title_posters")).toHaveLength(1);
    });
    const next = await findPosters("tmdb", [title], {
      budgetMs: 10,
      size: "stremio",
    });
    expect(next.get(title.id)).toBe(
      "https://image.tmdb.org/t/p/w500/as-movie.jpg",
    );
  });
});

describe.runIf(process.env.TVDB_LIVE_API_KEY)(
  "findPosters on TheTVDB, live",
  () => {
    beforeEach(() => {
      vi.stubEnv("TVDB_API_KEY", process.env.TVDB_LIVE_API_KEY ?? "");
    });
    it("finds series and movie posters by IMDb ID, small for the preview", async () => {
      vi.unstubAllGlobals();
      const titles = [
        { id: "tt1190634", type: "series" as const },
        { id: "tt0903747", type: "series" as const },
        { id: "tt15398776", type: "movie" as const },
        { id: "tt0111161", type: "movie" as const },
      ];
      const stremio = await findPosters("tvdb", titles, {
        budgetMs: 20_000,
        size: "stremio",
      });
      expect([...stremio.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
        titles.map(({ id }) => id).sort((a, b) => a.localeCompare(b)),
      );
      for (const url of stremio.values()) {
        expect(url).toMatch(/^https:\/\/artworks\.thetvdb\.com\/.+\.jpg$/u);
        expect(url).not.toMatch(/_t\.jpg$/u);
      }
      const preview = await findPosters("tvdb", titles, {
        budgetMs: 0,
        size: "preview",
      });
      expect(preview.get("tt1190634")).toBe(
        stremio.get("tt1190634")?.replace(/\.jpg$/u, "_t.jpg"),
      );
      const image = await fetch(preview.get("tt0111161") ?? "");
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/jpeg");
    });

    it("finds no poster for an IMDb ID that TheTVDB does not know", async () => {
      vi.unstubAllGlobals();
      const posters = await findPosters(
        "tvdb",
        [{ id: "tt99999999999", type: "movie" }],
        { budgetMs: 20_000, size: "stremio" },
      );
      expect(posters.size).toBe(0);
      expect(db.getTable("title_posters")).toMatchObject([
        { source: "tvdb", imdb_id: "tt99999999999", poster: null },
      ]);
    });
  },
);
