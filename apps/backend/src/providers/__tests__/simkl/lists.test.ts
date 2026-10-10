import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simklProvider } from "../../simkl";
import { SourceUnavailableError } from "../../types";
import { activities } from "./fixtures";
import {
  ageLibrary,
  apiCalls,
  clearCalls,
  ctx,
  json,
  resetSimklTest,
  restoreSimklTest,
  routes,
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

describe("simkl custom lists", () => {
  it("reports premium_only from a 200 body and remembers it", async () => {
    routes["GET /lists/123"] = () => ({
      error: "premium_only",
      message:
        "Custom list items are available to Simkl PRO and VIP members only.",
      item: { title: "Upgrade to Simkl PRO/VIP to unlock this list" },
    });

    const error: unknown = await simklProvider
      .fetchSource("me/lists/123", ctx())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).toMatchObject({ reason: "premium_only" });

    clearCalls();
    await expect(
      simklProvider.fetchSource("me/lists/123", ctx()),
    ).rejects.toMatchObject({ reason: "premium_only" });
    expect(apiCalls()).not.toContain("GET /lists/123");

    await expect(
      simklProvider.validateSource("me/lists/123", ctx()),
    ).rejects.toMatchObject({ reason: "premium_only" });
  });

  it("reads a PRO list in the owner's order, once per activity change", async () => {
    routes["GET /lists/456"] = (call) => {
      expect(call.url.searchParams.get("limit")).toBe("500");
      return {
        id: 456,
        name: "Best 90s sci-fi",
        type: "regular",
        media_type: "movies",
        pagination: { page: 1, limit: 500, total_items: 2, total_pages: 1 },
        items: [
          {
            title: "Ghost in the Shell",
            year: 1995,
            type: "anime",
            anime_type: "movie",
            ids: { simkl_id: 53536, imdb: "tt0113568", mal: "43" },
            position: 1,
          },
          {
            title: "The Matrix",
            year: 1999,
            type: "movie",
            ids: { simkl_id: 53992, tmdb: "603" },
            position: 2,
          },
        ],
      };
    };

    const { entries, complete } = await simklProvider.fetchSource(
      "me/lists/456",
      ctx(),
    );
    expect(complete).toBe(true);
    expect(entries).toEqual([
      {
        imdbId: "tt0113568",
        externalIds: { simkl: 53536 },
        type: "movie",
        title: "Ghost in the Shell",
        year: 1995,
        sourceUrl: "https://simkl.com/anime/53536/",
      },
      {
        imdbId: undefined,
        externalIds: { simkl: 53992, tmdb: { id: 603, type: "movie" } },
        type: "movie",
        title: "The Matrix",
        year: 1999,
        sourceUrl: "https://simkl.com/movies/53992/",
      },
    ]);

    ageLibrary();
    clearCalls();
    await simklProvider.fetchSource("me/lists/456", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);

    ageLibrary();
    clearCalls();
    routes["GET /sync/activities"] = () =>
      activities({
        all: "2026-10-04T00:00:00Z",
        lists: "2026-10-04T00:00:00Z",
      });
    await simklProvider.fetchSource("me/lists/456", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities", "GET /lists/456"]);
  });

  it("marks a list cut by the page cap as incomplete, also from its snapshot", async () => {
    routes["GET /lists/321"] = (call) => ({
      id: 321,
      name: "Everything",
      type: "regular",
      media_type: "movies",
      pagination: { page: 1, limit: 500, total_items: 20_000, total_pages: 40 },
      items: [
        {
          title: `Movie ${call.url.searchParams.get("page")}`,
          type: "movie",
          ids: {
            simkl_id: Number(call.url.searchParams.get("page")),
            imdb: `tt${String(call.url.searchParams.get("page")).padStart(7, "0")}`,
          },
        },
      ],
    });

    const first = await simklProvider.fetchSource("me/lists/321", ctx());
    expect(first.entries).toHaveLength(20);
    expect(first.complete).toBe(false);

    // The next read comes from the stored snapshot and keeps the flag.
    ageLibrary();
    clearCalls();
    const second = await simklProvider.fetchSource("me/lists/321", ctx());
    expect(apiCalls()).toEqual(["GET /sync/activities"]);
    expect(second.complete).toBe(false);
  });

  it("validates a list with its name and media type", async () => {
    routes["GET /lists/789"] = () => ({
      id: 789,
      name: "Weekend shows",
      media_type: "tv",
      items: [],
    });
    await expect(
      simklProvider.validateSource("me/lists/789", ctx()),
    ).resolves.toEqual({
      ok: true,
      ref: "me/lists/789",
      suggestedTitle: "Weekend shows",
      defaultDisplayMode: "series",
    });
    routes["GET /lists/790"] = () => json({ error: "private_list" }, 403);
    await expect(
      simklProvider.validateSource("me/lists/790", ctx()),
    ).rejects.toMatchObject({ reason: "private" });
  });
});
