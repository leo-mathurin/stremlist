import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traktProvider } from "../../trakt";
import {
  calls,
  connection,
  expectReason,
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

// ---------------------------------------------------------------------------
// Validation, resolution, freshness
// ---------------------------------------------------------------------------

describe("Trakt validateSource", () => {
  it("accepts charts without a network call", async () => {
    await expect(
      traktProvider.validateSource("trending", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "trending",
      suggestedTitle: "Trakt Trending",
      defaultDisplayMode: "split",
    });
    expect(calls).toHaveLength(0);
  });

  it("checks that a user exists before accepting a watchlist", async () => {
    route("GET /users/ghost", status(404));
    route("GET /users/ghost/watchlist", []);
    await expectReason(
      traktProvider.validateSource("users/ghost/watchlist", {
        connection: null,
      }),
      "not_found",
    );
  });

  it("names a public watchlist after its user", async () => {
    route("GET /users/sean", {
      username: "Sean",
      private: false,
      ids: { slug: "sean" },
    });
    route("GET /users/sean/watchlist", []);
    await expect(
      traktProvider.validateSource("users/sean/watchlist", {
        connection: null,
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "users/sean/watchlist",
      suggestedTitle: "Sean's watchlist",
      defaultDisplayMode: "split",
    });
  });

  it("reports a private watchlist", async () => {
    route("GET /users/hidden", status(401));
    await expectReason(
      traktProvider.validateSource("users/hidden/watchlist", {
        connection: null,
      }),
      "private",
    );
  });

  it("treats Trakt's 204 for a missing list as not_found", async () => {
    route("GET /users/sean/lists/nope", status(204));
    await expect(
      traktProvider.validateSource("users/sean/lists/nope", {
        connection: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("uses the list name and stores shared lists by numeric ID", async () => {
    route("GET /lists/imdb-top-rated-movies", {
      name: "IMDB: Top Rated Movies",
      ids: { slug: "imdb-top-rated-movies", trakt: 2142753 },
    });
    await expect(
      traktProvider.validateSource("lists/imdb-top-rated-movies", {
        connection: null,
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "lists/2142753",
      suggestedTitle: "IMDB: Top Rated Movies",
      defaultDisplayMode: "split",
    });
  });

  it("personal Source lists need a Connection, and up next shows series", async () => {
    await expectReason(
      traktProvider.validateSource("me/up-next", { connection: null }),
      "needs_connection",
    );
    route("GET /users/settings", { user: { username: "leo" } });
    await expect(
      traktProvider.validateSource("me/up-next", { connection: connection() }),
    ).resolves.toEqual({
      ok: true,
      ref: "me/up-next",
      suggestedTitle: "Trakt Up Next",
      defaultDisplayMode: "series",
    });
  });

  it("rejects refs it does not know", async () => {
    await expect(
      traktProvider.validateSource("users/sean", { connection: null }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("Trakt resolution and freshness", () => {
  it("keys entries without IMDb ID by Trakt ID and type", () => {
    expect(
      traktProvider.resolutionKey?.({
        type: "series",
        externalIds: { trakt: 999001 },
      }),
    ).toEqual({
      namespace: "trakt-show",
      externalId: "999001",
    });
    expect(
      traktProvider.resolutionKey?.({
        type: "movie",
        externalIds: { trakt: 5 },
      }),
    ).toEqual({
      namespace: "trakt-movie",
      externalId: "5",
    });
    expect(traktProvider.resolutionKey?.({ type: "movie" })).toBeNull();
    expect(traktProvider.resolverStrategies?.map((s) => s.name)).toEqual([
      "tmdb-external-ids",
    ]);
  });

  it("keeps public Source lists fresh longer than personal ones", () => {
    const freshness = (ref: string) => traktProvider.freshnessFor?.(ref);
    expect(freshness("trending")).toBe(6 * 60 * 60_000);
    expect(freshness("users/sean/watchlist")).toBe(6 * 60 * 60_000);
    expect(freshness("lists/42")).toBe(6 * 60 * 60_000);
    expect(freshness("me/watchlist")).toBe(30 * 60_000);
    expect(freshness("me/up-next")).toBe(30 * 60_000);
  });
});
