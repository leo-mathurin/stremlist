import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simklProvider } from "../../simkl";
import {
  apiCalls,
  calls,
  clearCalls,
  connection,
  ctx,
  json,
  resetSimklTest,
  restoreSimklTest,
  routes,
  storedLibrary,
} from "./harness";

vi.mock("../../../lib/r2", async () => {
  return (await import("./mocks")).r2Module;
});
vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetSimklTest);
afterEach(restoreSimklTest);

describe("simkl actions", () => {
  const actions = simklProvider.actions;
  if (!actions) throw new Error("Simkl must support Actions");

  function lastPost(): { path: string; body: unknown; headers: Headers } {
    const post = calls.filter((call) => call.method === "POST").at(-1);
    if (!post) throw new Error("no POST");
    return {
      path: post.url.pathname,
      body: JSON.parse(post.body ?? "null"),
      headers: post.headers,
    };
  }

  function acceptWrites(): void {
    for (const path of [
      "/sync/add-to-list",
      "/sync/history",
      "/sync/history/remove",
      "/sync/ratings",
      "/sync/ratings/remove",
    ]) {
      routes[`POST ${path}`] = () =>
        json({ added: {}, not_found: { movies: [], shows: [] } }, 201);
    }
  }

  it("derives membership from the same library", async () => {
    const membership = await actions.getMembership(connection);
    expect(new Set(membership.watchlist)).toEqual(
      new Set(["tt0000999", "tt0158552", "tt0110912"]),
    );
    expect(new Set(membership.watched)).toEqual(
      new Set(["tt0944947", "tt1520211", "tt0068646", "tt2560140"]),
    );
    expect(new Set(membership.watchedEpisodes)).toEqual(
      new Set([
        "tt0944947:1:1",
        "tt0944947:1:2",
        "tt1520211:1:2",
        // AniDB episode 1 of the Season 2 entry is TVDB (IMDb) S2E1.
        "tt2560140:2:1",
      ]),
    );
    expect(membership.ratings).toEqual({ tt0944947: 9, tt0068646: 10 });
  });

  it("adds to plan to watch", async () => {
    acceptWrites();
    await actions.perform(
      connection,
      { kind: "watchlist", add: true },
      { imdbId: "tt1375666", type: "movie" },
    );
    const post = lastPost();
    expect(post.path).toBe("/sync/add-to-list");
    expect(post.headers.get("Content-Type")).toBe("application/json");
    expect(post.headers.get("Authorization")).toBe("Bearer simkl_at_test");
    expect(post.body).toEqual({
      movies: [{ ids: { imdb: "tt1375666" }, to: "plantowatch" }],
    });
  });

  it("removes a planned title, but never a watched one", async () => {
    acceptWrites();
    await actions.getMembership(connection);

    await actions.perform(
      connection,
      { kind: "watchlist", add: false },
      { imdbId: "tt0158552", type: "series" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/history/remove",
      body: { shows: [{ ids: { imdb: "tt0158552" } }] },
    });

    clearCalls();
    await actions.perform(
      connection,
      { kind: "watchlist", add: false },
      { imdbId: "tt0068646", type: "movie" },
    );
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("marks episodes, shows and movies as watched", async () => {
    acceptWrites();
    await actions.perform(
      connection,
      { kind: "watched", add: true },
      {
        imdbId: "tt2560140",
        type: "series",
        episode: { season: 2, episode: 4 },
      },
    );
    expect(lastPost()).toEqual(
      expect.objectContaining({
        path: "/sync/history",
        body: {
          shows: [
            {
              ids: { imdb: "tt2560140" },
              use_tvdb_anime_seasons: true,
              seasons: [{ number: 2, episodes: [{ number: 4 }] }],
            },
          ],
        },
      }),
    );

    await actions.perform(
      connection,
      { kind: "watched", add: true },
      { imdbId: "tt0944947", type: "series" },
    );
    expect(lastPost().body).toEqual({
      shows: [{ ids: { imdb: "tt0944947" }, status: "completed" }],
    });

    await actions.perform(
      connection,
      { kind: "watched", add: false },
      { imdbId: "tt0068646", type: "movie" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/history/remove",
      body: { movies: [{ ids: { imdb: "tt0068646" } }] },
    });
  });

  it("unmarks a show season by season and keeps it in the library", async () => {
    acceptWrites();
    await actions.getMembership(connection);
    await actions.perform(
      connection,
      { kind: "watched", add: false },
      { imdbId: "tt0944947", type: "series" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/history/remove",
      body: {
        shows: [
          {
            ids: { imdb: "tt0944947" },
            use_tvdb_anime_seasons: true,
            seasons: [{ number: 1 }],
          },
        ],
      },
    });
  });

  it("rates and removes ratings", async () => {
    acceptWrites();
    await actions.perform(
      connection,
      { kind: "rating", rating: 8 },
      { imdbId: "tt0944947", type: "series" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/ratings",
      body: { shows: [{ ids: { imdb: "tt0944947" }, rating: 8 }] },
    });
    await actions.perform(
      connection,
      { kind: "rating", rating: null },
      { imdbId: "tt0068646", type: "movie" },
    );
    expect(lastPost()).toMatchObject({
      path: "/sync/ratings/remove",
      body: { movies: [{ ids: { imdb: "tt0068646" } }] },
    });
  });

  it("fails when Simkl does not know the title", async () => {
    routes["POST /sync/history"] = () =>
      json(
        {
          added: { movies: 0 },
          not_found: { movies: [{ ids: { imdb: "tt9999999" } }], shows: [] },
        },
        201,
      );
    await expect(
      actions.perform(
        connection,
        { kind: "watched", add: true },
        { imdbId: "tt9999999", type: "movie" },
      ),
    ).rejects.toThrow(/tt9999999/);
  });

  it("checks activities again on the next read after an Action", async () => {
    acceptWrites();
    await simklProvider.fetchSource("me/plantowatch", ctx());
    await actions.perform(
      connection,
      { kind: "watchlist", add: true },
      { imdbId: "tt1375666", type: "movie" },
    );
    expect(storedLibrary().checkedAt).toBe(0);
    clearCalls();
    await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);
  });

  it("marks every library list stale, since a title has one status", () => {
    const all = [
      "me/watching",
      "me/plantowatch",
      "me/hold",
      "me/completed",
      "me/dropped",
      "me/history",
    ];
    expect(actions.kinds).toEqual(["watchlist", "watched", "rating"]);
    expect(actions.affectedSources({ kind: "watchlist", add: true })).toEqual(
      all,
    );
    expect(actions.affectedSources({ kind: "watched", add: false })).toEqual(
      all,
    );
    expect(actions.affectedSources({ kind: "rating", rating: 5 })).toEqual(all);
  });
});
