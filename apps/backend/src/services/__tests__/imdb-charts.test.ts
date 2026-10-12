import { IMDB_WATCHLIST_SOURCE_ID_PATTERN } from "@stremlist/shared/constants";
import { CHART_REGISTRY, isChartId } from "@stremlist/shared/imdb-charts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchChart, normalizeImdbUserId } from "../imdb-scraper.js";

function titleNode(id: string, title = "Test Title", type = "Movie") {
  return {
    id,
    titleText: { text: title },
    titleType: { text: type },
    releaseYear: { year: 2020 },
    ratingsSummary: { aggregateRating: 7.5 },
    titleGenres: { genres: [{ genre: { text: "Drama" } }] },
    plot: { plotText: { plainText: "A plot." } },
    primaryImage: { url: "https://example.com/poster.jpg" },
    runtime: { seconds: 5400 },
    principalCredits: [],
  };
}

function respondWith(data: object) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("isChartId", () => {
  it("is true for every registry id", () => {
    for (const entry of CHART_REGISTRY) {
      expect(isChartId(entry.id)).toBe(true);
    }
  });

  it("is false for watchlist/list/handle/empty/bogus ids", () => {
    for (const id of [
      "ur12345678",
      "ls593621567",
      "p.colneedham",
      "",
      "imdb:bogus",
    ]) {
      expect(isChartId(id)).toBe(false);
    }
  });
});

describe("CHART_REGISTRY invariants", () => {
  it("has unique ids matching imdb:[a-z0-9-]+", () => {
    for (const entry of CHART_REGISTRY) {
      expect(entry.id).toMatch(/^imdb:[a-z0-9-]+$/);
    }
    expect(new Set(CHART_REGISTRY.map((entry) => entry.id)).size).toBe(
      CHART_REGISTRY.length,
    );
  });

  it("declares a valid defaultDisplayMode", () => {
    for (const entry of CHART_REGISTRY) {
      expect(["movie", "series", "split"]).toContain(entry.defaultDisplayMode);
    }
  });

  it("does not collide with the user-source id pattern", () => {
    for (const entry of CHART_REGISTRY) {
      expect(IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(entry.id)).toBe(false);
    }
  });
});

describe("fetchChart", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes chartTitles edges and splits movie/series by title type", async () => {
    respondWith({
      chartTitles: {
        total: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          { node: titleNode("tt0111161", "The Shawshank Redemption") },
          { node: titleNode("tt0903747", "Breaking Bad", "TV Series") },
        ],
      },
    });

    const { metas } = await fetchChart("imdb:top-rated-movies");

    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({
      id: "tt0111161",
      name: "The Shawshank Redemption",
      type: "movie",
    });
    expect(metas[1]).toMatchObject({
      id: "tt0903747",
      name: "Breaking Bad",
      type: "series",
    });
  });

  it("maps boxOffice releases and skips edges with empty titles[]", async () => {
    respondWith({
      topGrossingReleases: {
        edges: [
          { node: { release: { titles: [titleNode("tt1234567")] } } },
          { node: { release: { titles: [] } } },
        ],
      },
    });

    const { metas } = await fetchChart("imdb:box-office");

    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ id: "tt1234567", type: "movie" });
  });

  it("normalizes comingSoon edges", async () => {
    respondWith({ comingSoon: { edges: [{ node: titleNode("tt7654321") }] } });

    const { metas } = await fetchChart("imdb:coming-soon-movies");

    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ id: "tt7654321", type: "movie" });
  });

  it("throws for an unknown chart id without hitting the network", async () => {
    await expect(fetchChart("imdb:bogus")).rejects.toThrow(/Could not find/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("normalizeImdbUserId returns a chart id unchanged with no network call", async () => {
    expect(await normalizeImdbUserId("imdb:top-rated-movies")).toBe(
      "imdb:top-rated-movies",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("config source-id rule (mirrors the api.ts refine predicate)", () => {
  it.each([
    ["imdb:top-rated-movies", true],
    ["imdb:unknown", false],
    ["ur12345678", true],
    ["ls593621567", true],
    ["p.colneedham", true],
  ])("treats %s as accepted: %s", (id, accepted) => {
    expect(IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(id) || isChartId(id)).toBe(
      accepted,
    );
  });
});

// Live IMDb GraphQL calls, so a query that drifts from IMDb's schema fails
// here instead of silently in prod (a mocked suite missed the box-office
// enum-vs-string bug).
describe("integration: every built-in chart returns Stremio-shaped data", () => {
  it.each(CHART_REGISTRY.map((entry) => [entry.id, entry] as const))(
    "fetches %s",
    async (_id, entry) => {
      const { metas } = await fetchChart(entry.id);

      // Editorial charts are always populated.
      expect(metas.length).toBeGreaterThan(0);

      // One Stremio type per chart, so its default display mode never
      // produces an empty companion catalog.
      const expectedType =
        entry.defaultDisplayMode === "series" ? "series" : "movie";

      for (const meta of metas) {
        expect(meta.id).toMatch(/^tt\d+$/);
        expect(meta.type).toBe(expectedType);
        expect(meta.name).toBeTruthy();
        expect(meta.posterShape).toBe("poster");
      }
    },
    20_000,
  );

  it("returns the full Top 250 in rank order (first item is rank #1)", async () => {
    const { metas } = await fetchChart("imdb:top-rated-movies");
    expect(metas.length).toBe(250);
    expect(metas[0].id).toBe("tt0111161"); // The Shawshank Redemption
  });

  it("returns at most the 10 weekend box-office releases", async () => {
    const { metas } = await fetchChart("imdb:box-office");
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.length).toBeLessThanOrEqual(10);
  });
});
