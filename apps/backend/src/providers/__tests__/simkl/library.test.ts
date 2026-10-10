import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simklProvider } from "../../simkl";
import { activities, SHOWS } from "./fixtures";
import {
  ageLibrary,
  apiCalls,
  calls,
  clearCalls,
  connection,
  ctx,
  json,
  resetSimklTest,
  restoreSimklTest,
  routes,
} from "./harness";
import { r2 } from "./mocks";

vi.mock("../../../lib/r2", async () => {
  return (await import("./mocks")).r2Module;
});
vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetSimklTest);
afterEach(restoreSimklTest);

describe("simkl activities gating", () => {
  it("reads the full library once, activities first", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([
      "GET /sync/activities",
      "GET /sync/all-items/shows",
      "GET /sync/all-items/movies",
      "GET /sync/all-items/anime",
    ]);
    const first = calls[1].url.searchParams;
    expect(first.get("extended")).toBe("full_anime_seasons");
    expect(first.get("include_all_episodes")).toBe("yes");
  });

  it("reuses the snapshot inside the gate without any call", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    clearCalls();
    await simklProvider.fetchSource("me/completed", ctx());
    await simklProvider.actions?.getMembership(connection);
    expect(calls).toEqual([]);
  });

  it("never calls all-items when activities did not move", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    ageLibrary();
    clearCalls();
    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);
    expect(snapshot.entries).toHaveLength(4);
  });

  it("fetches only the delta when a status moved", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    ageLibrary();
    clearCalls();
    routes["GET /sync/activities"] = () =>
      activities({
        all: "2026-10-02T08:00:00Z",
        movies: { plantowatch: "2026-10-02T08:00:00Z" },
      });
    routes["GET /sync/all-items"] = () => ({
      movies: [
        {
          added_to_watchlist_at: "2026-10-02T08:00:00Z",
          status: "plantowatch",
          movie: {
            title: "Inception",
            year: 2010,
            ids: { simkl: 472214, imdb: "tt1375666" },
          },
        },
      ],
    });

    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([
      "GET /sync/activities",
      "GET /sync/all-items?date_from=2026-10-01T10:00:00Z",
    ]);
    expect(snapshot.entries.map((entry) => entry.imdbId).at(-1)).toBe(
      "tt1375666",
    );
  });

  it("diffs IDs on removals and reads the ratings delta", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    ageLibrary();
    clearCalls();
    routes["GET /sync/activities"] = () =>
      activities({
        all: "2026-10-03T08:00:00Z",
        movies: {
          removed_from_list: "2026-10-03T08:00:00Z",
          rated_at: "2026-10-03T08:00:00Z",
        },
      });
    routes["GET /sync/all-items"] = (call) => {
      expect(call.url.searchParams.get("extended")).toBe("simkl_ids_only");
      // Pulp Fiction (54130) is gone.
      return {
        shows: [297, 17465, 2090].map((simkl) => ({
          show: { ids: { simkl } },
        })),
        anime: [37089, 439744, 2544548].map((simkl) => ({
          show: { ids: { simkl } },
        })),
        movies: [53434, 999].map((simkl) => ({ movie: { ids: { simkl } } })),
      };
    };
    routes["GET /sync/ratings"] = () => ({
      movies: [
        {
          status: "completed",
          user_rating: null,
          movie: { title: "The Godfather", ids: { simkl: 53434 } },
        },
      ],
    });

    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([
      "GET /sync/activities",
      "GET /sync/all-items",
      "GET /sync/ratings?date_from=2026-10-01T10:00:00Z",
    ]);
    expect(snapshot.entries.map((entry) => entry.imdbId)).not.toContain(
      "tt0110912",
    );
    const membership = await simklProvider.actions?.getMembership(connection);
    expect(membership?.ratings).not.toHaveProperty("tt0068646");
  });

  it("falls back to lighter reads when Simkl answers max_items", async () => {
    let attempts = 0;
    routes["GET /sync/all-items/shows"] = (call) => {
      attempts += 1;
      if (call.url.searchParams.get("include_all_episodes") === "yes") {
        return json(
          { error: "max_items", code: 400, message: "Too many episodes" },
          400,
        );
      }
      expect(call.url.searchParams.get("include_all_episodes")).toBe(
        "original",
      );
      return SHOWS;
    };
    const snapshot = await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(attempts).toBe(2);
    expect(snapshot.entries).toHaveLength(4);
  });

  it("reads the full library again for another Simkl user", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    clearCalls();
    await simklProvider.fetchSource("me/plantowatch", {
      connection: { ...connection, username: "someone-else" },
    });
    expect(apiCalls()).toContain("GET /sync/all-items/shows");
  });
});

describe("simkl disconnect", () => {
  it("forgets the in-memory copies of the Connection's state", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());
    // While R2 is down, the in-memory copy answers inside the gate.
    r2.down = true;
    clearCalls();
    await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toEqual([]);

    simklProvider.forgetConnection?.("acc-1");

    clearCalls();
    await simklProvider.fetchSource("me/plantowatch", ctx());
    expect(apiCalls()).toContain("GET /sync/all-items/shows");
  });
});
