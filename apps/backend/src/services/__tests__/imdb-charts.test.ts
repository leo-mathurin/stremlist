import {
  CHART_REGISTRY,
  isChartId,
  IMDB_WATCHLIST_SOURCE_ID_PATTERN,
} from "@stremlist/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchChart, normalizeImdbUserId } from "../imdb-scraper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTitleNode(overrides: {
  id?: string;
  title?: string;
  type?: string;
}) {
  const { id = "tt0000001", title = "Test Title", type = "Movie" } = overrides;
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

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Registry / isChartId
// ---------------------------------------------------------------------------

describe("isChartId", () => {
  it("is true for every registry id", () => {
    for (const entry of CHART_REGISTRY) {
      expect(isChartId(entry.id)).toBe(true);
    }
  });

  it("is false for watchlist/list/handle/empty/bogus ids", () => {
    expect(isChartId("ur12345678")).toBe(false);
    expect(isChartId("ls593621567")).toBe(false);
    expect(isChartId("p.colneedham")).toBe(false);
    expect(isChartId("")).toBe(false);
    expect(isChartId("imdb:bogus")).toBe(false);
  });
});

describe("CHART_REGISTRY invariants", () => {
  it("has unique ids matching imdb:[a-z0-9-]+", () => {
    const seen = new Set<string>();
    for (const entry of CHART_REGISTRY) {
      expect(entry.id).toMatch(/^imdb:[a-z0-9-]+$/);
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }
    expect(seen.size).toBe(CHART_REGISTRY.length);
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

// ---------------------------------------------------------------------------
// fetchChart — fetch mocked
// ---------------------------------------------------------------------------

describe("fetchChart", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes chartTitles edges and splits movie/series by title type", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        data: {
          chartTitles: {
            total: 2,
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: makeTitleNode({
                  id: "tt0111161",
                  title: "The Shawshank Redemption",
                  type: "Movie",
                }),
              },
              {
                node: makeTitleNode({
                  id: "tt0903747",
                  title: "Breaking Bad",
                  type: "TV Series",
                }),
              },
            ],
          },
        },
      }),
    );

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
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        data: {
          topGrossingReleases: {
            edges: [
              {
                node: {
                  release: {
                    titles: [
                      makeTitleNode({ id: "tt1234567", title: "Blockbuster" }),
                    ],
                  },
                },
              },
              // Unreleased / unresolved title — must be skipped, not crash.
              { node: { release: { titles: [] } } },
            ],
          },
        },
      }),
    );

    const { metas } = await fetchChart("imdb:box-office");

    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ id: "tt1234567", type: "movie" });
  });

  it("normalizes comingSoon edges", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        data: {
          comingSoon: {
            edges: [
              {
                node: makeTitleNode({
                  id: "tt7654321",
                  title: "Future Film",
                  type: "Movie",
                }),
              },
            ],
          },
        },
      }),
    );

    const { metas } = await fetchChart("imdb:coming-soon-movies");

    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ id: "tt7654321", type: "movie" });
  });

  it("throws for an unknown chart id without hitting the network", async () => {
    await expect(fetchChart("imdb:bogus")).rejects.toThrow(/Could not find/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// normalizeImdbUserId — chart passthrough
// ---------------------------------------------------------------------------

describe("normalizeImdbUserId chart passthrough", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a chart id unchanged with no network call", async () => {
    const result = await normalizeImdbUserId("imdb:top-rated-movies");
    expect(result).toBe("imdb:top-rated-movies");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// config body source-id rule (mirrors api.ts refine predicate)
// ---------------------------------------------------------------------------

describe("config source-id rule", () => {
  const accepts = (v: string) =>
    IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(v) || isChartId(v);

  it("accepts a chart id", () => {
    expect(accepts("imdb:top-rated-movies")).toBe(true);
  });

  it("rejects an unknown imdb: id", () => {
    expect(accepts("imdb:unknown")).toBe(false);
  });

  it("still accepts watchlist/list/handle ids", () => {
    expect(accepts("ur12345678")).toBe(true);
    expect(accepts("ls593621567")).toBe(true);
    expect(accepts("p.colneedham")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real network calls to IMDb GraphQL for every chart.
//
// These hit the live GraphQL API (no mocks) so a query that drifts out of sync
// with IMDb's schema fails here instead of silently in prod — exactly the
// box-office enum-vs-string bug a mocked-only suite cannot catch.
// ---------------------------------------------------------------------------

describe("integration: every built-in chart returns Stremio-shaped data", () => {
  it.each(CHART_REGISTRY.map((entry) => [entry.id, entry] as const))(
    "fetches %s",
    async (_id, entry) => {
      const { metas } = await fetchChart(entry.id);

      // Editorial charts are always populated; an empty result means the query
      // broke or the schema changed.
      expect(metas.length).toBeGreaterThan(0);

      // Every chart maps to exactly one Stremio type (movie | series) so its
      // default display mode never produces an empty companion catalog.
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
    // DEFAULT_SORT_OPTIONS (added_at-asc) preserves chart rank order.
    expect(metas[0].id).toBe("tt0111161"); // The Shawshank Redemption
  });

  it("returns exactly the 10 weekend box-office releases", async () => {
    const { metas } = await fetchChart("imdb:box-office");
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.length).toBeLessThanOrEqual(10);
  });
});
