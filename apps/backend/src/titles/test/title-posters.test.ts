import { delay, http, HttpResponse, passthrough } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils";
import { db, resetRpc } from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { findPosters, resetPosterMemory } from "../title-posters";
import { resetTvdbToken } from "../tvdb";

const server = useMswServer();
const background = useBackgroundTasks();

const BOTH = {
  movie_results: [{ poster_path: "/as-movie.jpg" }],
  tv_results: [{ poster_path: "/as-show.jpg" }],
};

let tmdbFinds: string[] = [];

function answer(body: unknown, delayMs = 0) {
  server.use(
    http.get("https://api.themoviedb.org/3/find/:id", async ({ params }) => {
      tmdbFinds.push(String(params.id));
      await delay(delayMs);
      return new HttpResponse(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  tmdbFinds = [];
  db.reset();
  resetRpc();
  resetPosterMemory();
  resetTvdbToken();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("findPosters on TMDB", () => {
  it("takes the TMDB result of the Title's type first", async () => {
    answer(BOTH);
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
    answer({ movie_results: [{ poster_path: "../x?y" }] });
    const posters = await findPosters(
      "tmdb",
      [
        { id: "stremlist:unavailable:private", type: "movie" },
        { id: "tt0000003", type: "movie" },
      ],
      { budgetMs: 1000, size: "stremio" },
    );
    expect(posters.size).toBe(0);
    expect(tmdbFinds).toEqual(["tt0000003"]);
  });

  it("keeps its budget when the stored posters are slow to read", async () => {
    answer(BOTH);
    db.stalledTables.add("title_posters");
    const started = Date.now();
    const posters = await findPosters(
      "tmdb",
      [{ id: "tt0000009", type: "movie" }],
      { budgetMs: 50, size: "stremio" },
    );
    expect(posters.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(tmdbFinds).toEqual([]);
  });

  it("asks TMDB once for a Title that concurrent requests need", async () => {
    answer(BOTH, 20);
    const title = { id: "tt0000010", type: "movie" as const };
    const [first, second] = await Promise.all([
      findPosters("tmdb", [title], { budgetMs: 1000, size: "stremio" }),
      findPosters("tmdb", [title], { budgetMs: 1000, size: "stremio" }),
    ]);
    expect(tmdbFinds).toEqual(["tt0000010"]);
    expect(first.get(title.id)).toBe(
      "https://image.tmdb.org/t/p/w500/as-movie.jpg",
    );
    expect(second.get(title.id)).toBe(first.get(title.id));
  });

  it("answers within its budget and stores late answers for the next call", async () => {
    answer(BOTH, 200);
    const title = { id: "tt0000004", type: "movie" as const };

    const first = await findPosters("tmdb", [title], {
      budgetMs: 10,
      size: "stremio",
    });
    expect(first.size).toBe(0);

    await background.settle();
    expect(db.getTable("title_posters")).toHaveLength(1);
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
      server.use(
        http.all(/^https:\/\/[a-z0-9.-]*thetvdb\.com\//, () => passthrough()),
      );
    });
    it("finds series and movie posters by IMDb ID, small for the preview", async () => {
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
