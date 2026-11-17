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
import { findTmdbPosters, resetTmdbPosterMemory } from "../tmdb-posters";

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
  resetTmdbPosterMemory();
  vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("findTmdbPosters", () => {
  it("takes the TMDB result of the Title's type first", async () => {
    vi.stubGlobal("fetch", answer(BOTH));
    const posters = await findTmdbPosters(
      [
        { id: "tt0000001", type: "movie" },
        { id: "tt0000002", type: "series" },
      ],
      { budgetMs: 1000, size: "w342" },
    );
    expect(Object.fromEntries(posters)).toEqual({
      tt0000001: "https://image.tmdb.org/t/p/w342/as-movie.jpg",
      tt0000002: "https://image.tmdb.org/t/p/w342/as-show.jpg",
    });
  });

  it("ignores IDs that are not IMDb Title IDs and unsafe image paths", async () => {
    const fetch = answer({ movie_results: [{ poster_path: "../x?y" }] });
    vi.stubGlobal("fetch", fetch);
    const posters = await findTmdbPosters(
      [
        { id: "stremlist:unavailable:private", type: "movie" },
        { id: "tt0000003", type: "movie" },
      ],
      { budgetMs: 1000, size: "w500" },
    );
    expect(posters.size).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps its budget when the stored posters are slow to read", async () => {
    const fetch = answer(BOTH);
    vi.stubGlobal("fetch", fetch);
    // The read of the stored posters never answers.
    const read = vi
      .spyOn(MockQueryBuilder.prototype, "then")
      .mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    const posters = await findTmdbPosters(
      [{ id: "tt0000009", type: "movie" }],
      { budgetMs: 50, size: "w500" },
    );
    expect(posters.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetch).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("answers within its budget and stores late answers for the next call", async () => {
    vi.stubGlobal("fetch", answer(BOTH, 200));
    const title = { id: "tt0000004", type: "movie" as const };

    const first = await findTmdbPosters([title], {
      budgetMs: 10,
      size: "w500",
    });
    expect(first.size).toBe(0);

    await vi.waitFor(() => {
      expect(db.getTable("tmdb_posters")).toHaveLength(1);
    });
    const next = await findTmdbPosters([title], { budgetMs: 10, size: "w500" });
    expect(next.get(title.id)).toBe(
      "https://image.tmdb.org/t/p/w500/as-movie.jpg",
    );
  });
});
