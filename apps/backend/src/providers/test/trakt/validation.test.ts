import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { traktProvider } from "../../trakt";
import {
  calls,
  callsTo,
  connection,
  resetTraktTest,
  restoreTraktTest,
  route,
  status,
  unavailableReason,
} from "./harness";

const server = useMswServer();

beforeEach(() => resetTraktTest(server));
afterEach(restoreTraktTest);

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
    await expect(
      traktProvider.validateSource("boxoffice", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "boxoffice",
      suggestedTitle: "Trakt Box Office",
      defaultDisplayMode: "movie",
    });
    await expect(
      traktProvider.validateSource("collected", { connection: null }),
    ).resolves.toMatchObject({
      ok: true,
      suggestedTitle: "Trakt Most Collected",
    });
    expect(calls).toHaveLength(0);
  });

  it("checks that a user exists before accepting a watchlist", async () => {
    route("GET /users/ghost", status(404));
    route("GET /users/ghost/watchlist", []);
    expect(
      await unavailableReason(
        traktProvider.validateSource("users/ghost/watchlist", {
          connection: null,
        }),
      ),
    ).toBe("not_found");
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

  it("names a public user's favorites, ratings, history and collection", async () => {
    route("GET /users/sean", { username: "Sean", ids: { slug: "sean" } });
    route("GET /users/sean/favorites", []);
    route("GET /users/sean/ratings", []);
    route("GET /users/sean/history", []);
    route("GET /users/sean/collection/movies", []);
    for (const [kind, mode] of [
      ["favorites", "split"],
      ["ratings", "split"],
      ["history", "split"],
      ["collection", "split"],
    ]) {
      await expect(
        traktProvider.validateSource(`users/Sean/${kind}`, {
          connection: null,
        }),
      ).resolves.toEqual({
        ok: true,
        ref: `users/sean/${kind}`,
        suggestedTitle: `Sean's ${kind}`,
        defaultDisplayMode: mode,
      });
    }
    expect(callsTo("/users/sean/watched/movies")).toHaveLength(0);
    expect(
      callsTo("/users/sean/history")[0].url.searchParams.get("limit"),
    ).toBe("1");
  });

  it("reports a private user's ratings", async () => {
    route("GET /users/hidden", status(401));
    expect(
      await unavailableReason(
        traktProvider.validateSource("users/hidden/ratings", {
          connection: null,
        }),
      ),
    ).toBe("private");
  });

  it("reports a private watchlist", async () => {
    route("GET /users/hidden", status(401));
    expect(
      await unavailableReason(
        traktProvider.validateSource("users/hidden/watchlist", {
          connection: null,
        }),
      ),
    ).toBe("private");
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

  it("names a smart list and starts it with its only media type", async () => {
    route("GET /smart-lists/silos", {
      name: "Silos",
      privacy: "public",
      ids: { trakt: 42, slug: "silos" },
      source: "discover",
      media_type: "shows",
      filters: { genres: ["science-fiction"] },
    });
    await expect(
      traktProvider.validateSource("smart-lists/silos", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "smart-lists/silos",
      suggestedTitle: "Silos",
      defaultDisplayMode: "series",
    });
  });

  it("reports a smart list that is missing or private as not_found", async () => {
    route("GET /smart-lists/hidden", status(404));
    expect(
      await unavailableReason(
        traktProvider.validateSource("smart-lists/hidden", {
          connection: null,
        }),
      ),
    ).toBe("not_found");
  });

  it("personal Source lists need a Connection, and up next shows series", async () => {
    expect(
      await unavailableReason(
        traktProvider.validateSource("me/up-next", { connection: null }),
      ),
    ).toBe("needs_connection");
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

  it("accepts the public calendars without a network call", async () => {
    await expect(
      traktProvider.validateSource("calendars/shows/new", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "calendars/shows/new",
      suggestedTitle: "Trakt New Shows",
      defaultDisplayMode: "series",
    });
    await expect(
      traktProvider.validateSource("calendars/dvd", { connection: null }),
    ).resolves.toEqual({
      ok: true,
      ref: "calendars/dvd",
      suggestedTitle: "Trakt DVD Releases",
      defaultDisplayMode: "movie",
    });
    expect(calls).toHaveLength(0);
    await expect(
      traktProvider.validateSource("calendars/shows/finales", {
        connection: null,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
  });

  it("Continue Watching and the Calendar need a Connection", async () => {
    for (const ref of ["me/continue-watching", "me/calendar"]) {
      expect(
        await unavailableReason(
          traktProvider.validateSource(ref, { connection: null }),
        ),
      ).toBe("needs_connection");
    }
    route("GET /users/settings", { user: { username: "leo" } });
    await expect(
      traktProvider.validateSource("me/continue-watching", {
        connection: connection(),
      }),
    ).resolves.toEqual({
      ok: true,
      ref: "me/continue-watching",
      suggestedTitle: "Trakt Continue Watching",
      defaultDisplayMode: "split",
    });
    await expect(
      traktProvider.validateSource("me/calendar", { connection: connection() }),
    ).resolves.toMatchObject({ ok: true, suggestedTitle: "Trakt Calendar" });
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
    expect(freshness("users/sean/ratings")).toBe(6 * 60 * 60_000);
    expect(freshness("me/favorites")).toBe(30 * 60_000);
  });
});
