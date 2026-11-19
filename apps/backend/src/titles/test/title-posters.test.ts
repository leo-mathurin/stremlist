import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils";
import { untilSettled } from "../../test/helpers/clock.test-utils";
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

function answer(body: unknown, before?: (id: string) => Promise<void>) {
  server.use(
    http.get("https://api.themoviedb.org/3/find/:id", async ({ params }) => {
      const id = String(params.id);
      tmdbFinds.push(id);
      await before?.(id);
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
      { budgetMs: Infinity, size: "preview" },
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
      { budgetMs: Infinity, size: "stremio" },
    );
    expect(posters.size).toBe(0);
    expect(tmdbFinds).toEqual(["tt0000003"]);
  });

  it("keeps its budget when the stored posters are slow to read", async () => {
    answer(BOTH);
    db.stalledTables.add("title_posters");
    vi.useFakeTimers();
    const started = Date.now();
    const posters = await untilSettled(
      findPosters("tmdb", [{ id: "tt0000009", type: "movie" }], {
        budgetMs: 50,
        size: "stremio",
      }),
    );
    expect(posters.size).toBe(0);
    expect(Date.now() - started).toBe(50);
    expect(tmdbFinds).toEqual([]);
  });

  it("asks TMDB once for a Title that concurrent requests need", async () => {
    const title = { id: "tt0000010", type: "movie" as const };
    const other = { id: "tt0000011", type: "movie" as const };
    const firstAsked = Promise.withResolvers<void>();
    const secondDecided = Promise.withResolvers<void>();
    answer(BOTH, async (id) => {
      if (id === other.id) secondDecided.resolve();
      else if (tmdbFinds.length === 1) {
        firstAsked.resolve();
        await secondDecided.promise;
      }
    });
    try {
      const firstCall = findPosters("tmdb", [title], {
        budgetMs: Infinity,
        size: "stremio",
      });
      await firstAsked.promise;
      const second = await findPosters("tmdb", [title, other], {
        budgetMs: Infinity,
        size: "stremio",
      });
      const first = await firstCall;
      expect(tmdbFinds).toEqual(["tt0000010", "tt0000011"]);
      expect(first.get(title.id)).toBe(
        "https://image.tmdb.org/t/p/w500/as-movie.jpg",
      );
      expect(second.get(title.id)).toBe(first.get(title.id));
    } finally {
      secondDecided.resolve();
    }
  });

  it("answers within its budget and stores late answers for the next call", async () => {
    const asked = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    answer(BOTH, () => {
      asked.resolve();
      return late.promise;
    });
    const title = { id: "tt0000004", type: "movie" as const };
    vi.useFakeTimers();

    try {
      const firstCall = findPosters("tmdb", [title], {
        budgetMs: 10,
        size: "stremio",
      });
      await asked.promise;
      await vi.advanceTimersByTimeAsync(10);
      const first = await firstCall;
      expect(first.size).toBe(0);
      expect(db.getTable("title_posters")).toHaveLength(0);
    } finally {
      late.resolve();
    }

    await untilSettled(background.settle());
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
