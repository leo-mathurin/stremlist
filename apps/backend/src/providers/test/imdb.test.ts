import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { IMDB_GRAPHQL } from "../../test/helpers/imdb.test-utils";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { imdbProvider } from "../imdb";
import { SourceUnavailableError } from "../types";

const ctx = { connection: null };

const graphqlRequest = z.object({
  operationName: z.string(),
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

const server = useMswServer();

function ratedTitle(id: string, date: string, type = "Movie") {
  return {
    node: {
      title: {
        id,
        titleText: { text: `Title ${id}` },
        titleType: { text: type },
        userRating: { date },
      },
    },
  };
}

const FORBIDDEN = {
  data: { advancedTitleSearch: null },
  errors: [
    {
      message: "Requested users ratings are private",
      extensions: { code: "FORBIDDEN" },
    },
  ],
};

function serve(...responses: Record<string, unknown>[]) {
  const requests: z.infer<typeof graphqlRequest>[] = [];
  server.use(
    http.post(IMDB_GRAPHQL, async ({ request }) => {
      requests.push(graphqlRequest.parse(await request.json()));
      const next = responses.shift();
      if (!next) throw new Error("Unexpected IMDb request");
      return HttpResponse.json(next);
    }),
  );
  return requests;
}

describe("imdbProvider ratings", () => {
  it("validates public ratings with one small page and keeps the suffix", async () => {
    const requests = serve({ data: { advancedTitleSearch: { total: 3 } } });

    await expect(
      imdbProvider.validateSource("ur1000000/ratings", ctx),
    ).resolves.toEqual({ ok: true, ref: "ur1000000/ratings" });
    expect(requests).toHaveLength(1);
    expect(requests[0].operationName).toBe("ValidateRatings");
    expect(requests[0].query).toContain("first: 1");
    expect(requests[0].variables).toEqual({ userId: "ur1000000" });
  });

  it.each([
    ["not_found", "a missing user", { data: { predefinedList: null } }],
    [
      "private",
      "a user whose watchlist is also private",
      {
        data: { predefinedList: null },
        errors: [
          { message: "Permission denied", extensions: { code: "FORBIDDEN" } },
        ],
      },
    ],
    [
      "private",
      "a user with a public watchlist",
      {
        data: {
          predefinedList: { id: "ls1", visibility: { id: "PUBLIC" } },
        },
      },
    ],
  ])(
    "refuses refused ratings as %s for %s",
    async (reason, _case, watchlist) => {
      const requests = serve(FORBIDDEN, watchlist);

      await expect(
        imdbProvider.validateSource("ur12345678/ratings", ctx),
      ).resolves.toEqual({ ok: false, reason });
      expect(requests.map((request) => request.operationName)).toEqual([
        "ValidateRatings",
        "ValidateWatchlist",
      ]);
      expect(requests[1].variables).toEqual({ urConst: "ur12345678" });
    },
  );

  it("throws on a failed search instead of calling the user missing", async () => {
    serve({
      data: { advancedTitleSearch: null },
      errors: [
        {
          message: "GraphQL request failed",
          extensions: { code: "SERVICE_UNAVAILABLE_ERROR" },
        },
      ],
    });

    await expect(
      imdbProvider.validateSource("ur1000000/ratings", ctx),
    ).rejects.toThrow(/could not check/);
  });

  it("reads the ratings oldest first, dated by the rating", async () => {
    const requests = serve({
      data: {
        advancedTitleSearch: {
          total: 3,
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            ratedTitle("tt0000003", "2026-03-01T00:00:00.000Z"),
            ratedTitle("tt0000002", "2026-02-01T00:00:00.000Z", "TV Series"),
            ratedTitle("tt0000001", "2026-01-01T00:00:00.000Z"),
          ],
        },
      },
    });

    const { entries, complete } = await imdbProvider.fetchSource(
      "ur1000000/ratings",
      ctx,
    );

    expect(complete).toBe(true);
    expect(
      entries.map(({ imdbId, addedAt, meta }) => [imdbId, addedAt, meta?.type]),
    ).toEqual([
      ["tt0000001", "2026-01-01T00:00:00.000Z", "movie"],
      ["tt0000002", "2026-02-01T00:00:00.000Z", "series"],
      ["tt0000003", "2026-03-01T00:00:00.000Z", "movie"],
    ]);
    expect(requests[0].operationName).toBe("UserRatings");
    expect(requests[0].query).toContain("userRating(userId: $userId)");
    expect(requests[0].query).toContain("SINGLE_USER_RATING_DATE");
    expect(requests[0].variables).toMatchObject({ userId: "ur1000000" });
  });

  it("reads private ratings as a private Source list", async () => {
    serve(FORBIDDEN);

    const read = imdbProvider.fetchSource("ur12345678/ratings", ctx);

    await expect(read).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(read).rejects.toMatchObject({ reason: "private" });
  });

  it("keeps a failed search out of the Source list problems", async () => {
    serve({
      data: { advancedTitleSearch: null },
      errors: [
        {
          message: "GraphQL request failed",
          extensions: { code: "SERVICE_UNAVAILABLE_ERROR" },
        },
      ],
    });

    const read = imdbProvider.fetchSource("ur1000000/ratings", ctx);

    await expect(read).rejects.toThrow(/could not read/);
    await expect(read).rejects.not.toBeInstanceOf(SourceUnavailableError);
  });

  it("still reads a bare user ID as the watchlist", async () => {
    const requests = serve({
      data: {
        predefinedList: {
          id: "ls1",
          visibility: { id: "PUBLIC" },
          titleListItemSearch: { total: 0, edges: [] },
        },
      },
    });

    await imdbProvider.fetchSource("ur1000000", ctx);

    expect(requests[0].operationName).toBe("WatchListPage");
  });
});

describe("imdbProvider freshness", () => {
  it("refreshes watchlists, lists and ratings after 10 minutes, charts after 6 hours", () => {
    const freshness = (ref: string) => imdbProvider.freshnessFor?.(ref);
    expect(freshness("ur12345678")).toBe(10 * 60_000);
    expect(freshness("ur12345678/ratings")).toBe(10 * 60_000);
    expect(freshness("ls012345678")).toBe(10 * 60_000);
    expect(freshness("imdb:most-popular-movies")).toBe(6 * 60 * 60_000);
  });
});
