import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traktProvider } from "../../trakt";
import type { ProviderActions } from "../../types";
import {
  clerks,
  halloween,
  listed,
  mandalorian,
  noImdbShow,
  pitt,
} from "./fixtures";
import type { Call } from "./harness";
import {
  calls,
  clearCalls,
  connection,
  pages,
  required,
  resetTraktTest,
  restoreTraktTest,
  route,
  status,
} from "./harness";

vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetTraktTest);
afterEach(restoreTraktTest);

describe("Trakt actions", () => {
  const actions: ProviderActions = required(traktProvider.actions);

  it("reads membership: watchlist, watched episodes and ratings", async () => {
    route(
      "GET /users/me/watchlist",
      pages([
        [
          listed("movie", clerks, "2022-01-01T00:00:00.000Z", 1),
          listed("show", pitt, "2022-01-01T00:00:00.000Z", 2),
          listed("episode", mandalorian, "2022-01-01T00:00:00.000Z", 3),
        ],
      ]),
    );
    route("GET /sync/watched/movies", [
      {
        plays: 2,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        movie: halloween,
      },
    ]);
    route("GET /sync/watched/shows", [
      {
        plays: 3,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        show: mandalorian,
        seasons: [
          {
            number: 1,
            episodes: [
              { number: 1, plays: 1 },
              { number: 2, plays: 2 },
            ],
          },
          { number: 2, episodes: [{ number: 1, plays: 1 }] },
        ],
      },
      {
        plays: 0,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        show: pitt,
        seasons: [],
      },
      {
        plays: 1,
        last_watched_at: "2024-01-01T00:00:00.000Z",
        show: noImdbShow,
        seasons: [{ number: 1, episodes: [{ number: 1 }] }],
      },
    ]);
    route("GET /sync/ratings/movies", [
      {
        rated_at: "2024-01-01T00:00:00.000Z",
        rating: 8,
        type: "movie",
        movie: clerks,
      },
    ]);
    route("GET /sync/ratings/shows", [
      {
        rated_at: "2024-01-01T00:00:00.000Z",
        rating: 10,
        type: "show",
        show: mandalorian,
      },
    ]);

    const membership = await actions.getMembership(connection());

    expect(membership).toEqual({
      watchlist: ["tt11128440", "tt31938062"],
      watched: ["tt10665342", "tt8111088"],
      watchedEpisodes: ["tt8111088:1:1", "tt8111088:1:2", "tt8111088:2:1"],
      ratings: { tt11128440: 8, tt8111088: 10 },
    });
    expect(
      calls.every((c) => c.headers.get("Authorization") === "Bearer token-1"),
    ).toBe(true);
  });

  async function performed(
    intent: Parameters<typeof actions.perform>[1],
    target: Parameters<typeof actions.perform>[2],
  ): Promise<Call> {
    route(`POST /sync/watchlist`, {
      added: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/watchlist/remove`, {
      deleted: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/history`, {
      added: {},
      not_found: { movies: [], shows: [], episodes: [] },
    });
    route(`POST /sync/history/remove`, {
      deleted: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/ratings`, {
      added: {},
      not_found: { movies: [], shows: [] },
    });
    route(`POST /sync/ratings/remove`, {
      deleted: {},
      not_found: { movies: [], shows: [] },
    });
    clearCalls();
    await actions.perform(connection(), intent, target);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer token-1");
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    return calls[0];
  }

  it("adds and removes watchlist entries by IMDb ID", async () => {
    const add = await performed(
      { kind: "watchlist", add: true },
      { imdbId: "tt11128440", type: "movie" },
    );
    expect(add.url.pathname).toBe("/sync/watchlist");
    expect(add.body).toEqual({ movies: [{ ids: { imdb: "tt11128440" } }] });

    const remove = await performed(
      { kind: "watchlist", add: false },
      { imdbId: "tt8111088", type: "series" },
    );
    expect(remove.url.pathname).toBe("/sync/watchlist/remove");
    expect(remove.body).toEqual({ shows: [{ ids: { imdb: "tt8111088" } }] });
  });

  it("marks a movie, a show and one episode as watched or unwatched", async () => {
    const movie = await performed(
      { kind: "watched", add: true },
      { imdbId: "tt11128440", type: "movie" },
    );
    expect(movie.url.pathname).toBe("/sync/history");
    expect(movie.body).toEqual({ movies: [{ ids: { imdb: "tt11128440" } }] });

    const show = await performed(
      { kind: "watched", add: true },
      { imdbId: "tt8111088", type: "series" },
    );
    expect(show.body).toEqual({ shows: [{ ids: { imdb: "tt8111088" } }] });

    const episode = await performed(
      { kind: "watched", add: false },
      {
        imdbId: "tt8111088",
        type: "series",
        episode: { season: 2, episode: 5 },
      },
    );
    expect(episode.url.pathname).toBe("/sync/history/remove");
    expect(episode.body).toEqual({
      shows: [
        {
          ids: { imdb: "tt8111088" },
          seasons: [{ number: 2, episodes: [{ number: 5 }] }],
        },
      ],
    });
  });

  it("rates and removes a rating", async () => {
    const rate = await performed(
      { kind: "rating", rating: 7 },
      { imdbId: "tt8111088", type: "series" },
    );
    expect(rate.url.pathname).toBe("/sync/ratings");
    expect(rate.body).toEqual({
      shows: [{ ids: { imdb: "tt8111088" }, rating: 7 }],
    });

    const clear = await performed(
      { kind: "rating", rating: null },
      { imdbId: "tt11128440", type: "movie" },
    );
    expect(clear.url.pathname).toBe("/sync/ratings/remove");
    expect(clear.body).toEqual({ movies: [{ ids: { imdb: "tt11128440" } }] });
  });

  it("fails when Trakt does not know the Title", async () => {
    route("POST /sync/watchlist", {
      added: { movies: 0 },
      not_found: { movies: [{ ids: { imdb: "tt0000001" } }] },
    });
    await expect(
      actions.perform(
        connection(),
        { kind: "watchlist", add: true },
        { imdbId: "tt0000001", type: "movie" },
      ),
    ).rejects.toThrow(/does not know/);
  });

  it("fails on account limits and VIP-only writes", async () => {
    route("POST /sync/watchlist", status(420));
    await expect(
      actions.perform(
        connection(),
        { kind: "watchlist", add: true },
        { imdbId: "tt11128440", type: "movie" },
      ),
    ).rejects.toMatchObject({ name: "HttpError", status: 420 });
  });

  it("names the Source lists that each Action changes", () => {
    expect(actions.kinds).toEqual(["watchlist", "watched", "rating"]);
    expect(actions.affectedSources({ kind: "watchlist", add: true })).toEqual([
      "me/watchlist",
    ]);
    expect(actions.affectedSources({ kind: "watched", add: false })).toEqual([
      "me/history",
      "me/up-next",
    ]);
    expect(actions.affectedSources({ kind: "rating", rating: 5 })).toEqual([]);
  });
});
