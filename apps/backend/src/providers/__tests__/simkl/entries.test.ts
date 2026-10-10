import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simklProvider } from "../../simkl";
import { simklItemUrl } from "../../simkl/entries";
import { calls, ctx, resetSimklTest, restoreSimklTest } from "./harness";

vi.mock("../../../lib/r2", async () => {
  return (await import("./mocks")).r2Module;
});
vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetSimklTest);
afterEach(restoreSimklTest);

describe("simkl entries", () => {
  it("maps statuses to entries, oldest added first", async () => {
    const { entries } = await simklProvider.fetchSource(
      "me/plantowatch",
      ctx(),
    );
    expect(entries).toEqual([
      {
        imdbId: "tt0000999",
        externalIds: { simkl: 999 },
        type: "movie",
        title: "Old Movie",
        year: 1950,
        sourceUrl: "https://simkl.com/movies/999/old-movie",
      },
      {
        imdbId: "tt0158552",
        externalIds: { simkl: 297, tmdb: { id: 1981, type: "series" } },
        type: "series",
        title: "Charmed",
        year: 1998,
        sourceUrl: "https://simkl.com/tv/297/charmed",
        addedAt: "2018-02-24T23:55:13Z",
      },
      {
        imdbId: undefined,
        externalIds: { simkl: 2544548, tmdb: { id: 1333100, type: "movie" } },
        type: "movie",
        title: "Attack on Titan: The Last Attack",
        year: 2024,
        sourceUrl: "https://simkl.com/anime/2544548/",
        addedAt: "2025-01-01T00:00:00Z",
      },
      {
        imdbId: "tt0110912",
        externalIds: { simkl: 54130 },
        type: "movie",
        title: "Pulp Fiction",
        year: 1994,
        sourceUrl: "https://simkl.com/movies/54130/pulp-fiction",
        addedAt: "2026-05-14T06:49:56Z",
      },
    ]);
  });

  it("gives anime without an IMDb ID a resolver key", async () => {
    const { entries } = await simklProvider.fetchSource("me/completed", ctx());
    const bebop = entries.find((entry) => entry.title === "Cowboy Bebop");
    expect(bebop).toMatchObject({
      type: "series",
      externalIds: { simkl: 37089 },
    });
    expect(bebop && simklProvider.resolutionKey?.(bebop)).toEqual({
      namespace: "simkl",
      externalId: "37089",
    });
    expect(simklProvider.resolverStrategies?.map((s) => s.name)).toEqual([
      "tmdb-external-ids",
    ]);
  });

  it("needs a Connection for every Source list", async () => {
    await expect(
      simklProvider.fetchSource("me/plantowatch", { connection: null }),
    ).rejects.toMatchObject({ reason: "needs_connection" });
    await expect(
      simklProvider.validateSource("me/watching", { connection: null }),
    ).resolves.toEqual({ ok: false, reason: "needs_connection" });
    await expect(
      simklProvider.validateSource("users/1/watchlist", ctx()),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      simklProvider.validateSource("me/hold", ctx()),
    ).resolves.toMatchObject({ ok: true, ref: "me/hold" });
    expect(calls).toEqual([]);
  });

  it("lists everything watched as history, oldest watch first", async () => {
    const { entries } = await simklProvider.fetchSource("me/history", ctx());
    expect(entries.map((entry) => entry.title)).toEqual([
      "The Godfather",
      "Shingeki no Kyojin Season 2",
      "Cowboy Bebop",
      "Game of Thrones",
      "The Walking Dead",
    ]);
    await expect(
      simklProvider.validateSource("me/history", ctx()),
    ).resolves.toMatchObject({ ok: true, suggestedTitle: "History" });
  });

  it("links every entry back to its Simkl page", async () => {
    const { entries } = await simklProvider.fetchSource("me/completed", ctx());
    expect(entries.map((entry) => entry.sourceUrl)).toContain(
      "https://simkl.com/tv/17465/game-of-thrones",
    );
    expect(entries.every((entry) => entry.sourceUrl)).toBe(true);
  });

  it("builds the link back to a Simkl title page", () => {
    expect(simklItemUrl({ simkl: 17465, kind: "shows", slug: "got" })).toBe(
      "https://simkl.com/tv/17465/got",
    );
    expect(simklItemUrl({ simkl: 53434, kind: "movies" })).toBe(
      "https://simkl.com/movies/53434/",
    );
  });
});
