import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scraperMocks = vi.hoisted(() => ({
  fetchTitlesByIds:
    vi.fn<(ids: string[]) => Promise<Map<string, StremioMeta>>>(),
}));

vi.mock("../../services/imdb-scraper", () => scraperMocks);

import { enrichTitles } from "../enrich";

// enrich.ts keeps an in-memory cache for the whole process: every test uses
// its own IMDb IDs so one test's lookups never answer another's.
let nextId = 1000000;
function freshId(): string {
  nextId += 1;
  return `tt${nextId}`;
}

function meta(id: string, overrides: Partial<StremioMeta> = {}): StremioMeta {
  return {
    id,
    type: "movie",
    name: `IMDb ${id}`,
    poster: null,
    posterShape: "poster",
    genres: [],
    description: "",
    ...overrides,
  };
}

const fetchMock = vi.fn<typeof fetch>();

function cinemetaUrl(type: string, id: string): string {
  return `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([url]) => urlOf(url));
}

beforeEach(() => {
  scraperMocks.fetchTitlesByIds.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("enrichTitles", () => {
  it("does not renew the enrichment timestamp on memory reuse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = freshId();
    const at = new Date("2026-02-01T00:00:00Z");
    vi.setSystemTime(at);
    scraperMocks.fetchTitlesByIds.mockResolvedValue(new Map([[id, meta(id)]]));
    await enrichTitles([{ imdbId: id }]);
    vi.setSystemTime(at.getTime() + 60 * 60_000);
    expect((await enrichTitles([{ imdbId: id }])).get(id)?.enrichedAt).toBe(
      at.toISOString(),
    );
  });

  it("re-enriches expired and undated metadata while retaining recent entries", async () => {
    const [old, legacy, recent] = [freshId(), freshId(), freshId()];
    const previous = new Map<string, StremioMeta & { enrichedAt?: string }>([
      [
        old,
        {
          ...meta(old),
          enrichedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
        },
      ],
      [legacy, meta(legacy)],
      [recent, { ...meta(recent), enrichedAt: new Date().toISOString() }],
    ]);
    scraperMocks.fetchTitlesByIds.mockImplementation((ids) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, meta(id, { imdbRating: "9.0" })])),
      ),
    );
    const result = await enrichTitles(
      [old, legacy, recent].map((imdbId) => ({ imdbId })),
      previous,
    );
    expect(scraperMocks.fetchTitlesByIds).toHaveBeenCalledExactlyOnceWith([
      old,
      legacy,
    ]);
    expect(result.get(old)?.imdbRating).toBe("9.0");
    expect(result.get(legacy)?.enrichedAt).toBeDefined();
    expect(result.get(recent)).toEqual(previous.get(recent));
  });

  it("reuses metadata from the previous cache generation without any lookup", async () => {
    const id = freshId();
    const previous = new Map([
      [
        id,
        {
          ...meta(id, { name: "Cached" }),
          enrichedAt: new Date().toISOString(),
        },
      ],
    ]);

    const result = await enrichTitles([{ imdbId: id }], previous);

    expect(result.get(id)?.name).toBe("Cached");
    expect(scraperMocks.fetchTitlesByIds).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks IMDb in one batch for every unknown Title", async () => {
    const [a, b, known] = [freshId(), freshId(), freshId()];
    scraperMocks.fetchTitlesByIds.mockImplementation((ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, meta(id)]))),
    );

    const result = await enrichTitles(
      [{ imdbId: a }, { imdbId: known }, { imdbId: b }, { imdbId: a }],
      new Map([
        [
          known,
          {
            ...meta(known, { name: "Known" }),
            enrichedAt: new Date().toISOString(),
          },
        ],
      ]),
    );

    expect(scraperMocks.fetchTitlesByIds).toHaveBeenCalledExactlyOnceWith([
      a,
      b,
    ]);
    expect([...result.keys()].sort()).toEqual([a, b, known].sort());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remembers IMDb answers for the next refresh", async () => {
    const id = freshId();
    scraperMocks.fetchTitlesByIds.mockResolvedValue(new Map([[id, meta(id)]]));

    await enrichTitles([{ imdbId: id }]);
    const again = await enrichTitles([{ imdbId: id }]);

    expect(again.get(id)?.name).toBe(`IMDb ${id}`);
    expect(scraperMocks.fetchTitlesByIds).toHaveBeenCalledOnce();
  });

  it("falls back to Cinemeta when IMDb throws", async () => {
    const id = freshId();
    scraperMocks.fetchTitlesByIds.mockRejectedValue(new Error("IMDb 503"));
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        urlOf(url) === cinemetaUrl("series", id)
          ? Response.json({
              meta: {
                name: "From Cinemeta",
                poster: "https://img.example/p.jpg",
                genres: ["Drama"],
                description: "A show.",
                imdbRating: "8.1",
                releaseInfo: "2019-2023",
                runtime: "45 min",
                released: "2019-01-01T00:00:00.000Z",
                director: ["Someone"],
                cast: ["A", "B", "C", "D", "E", "F"],
              },
            })
          : new Response("not found", { status: 404 }),
      ),
    );

    const result = await enrichTitles([{ imdbId: id, type: "series" }]);

    expect(requestedUrls()).toEqual([cinemetaUrl("series", id)]);
    expect(result.get(id)).toMatchObject({
      id,
      type: "series",
      name: "From Cinemeta",
      poster: "https://img.example/p.jpg",
      posterShape: "poster",
      genres: ["Drama"],
      description: "A show.",
      imdbRating: "8.1",
      releaseInfo: "2019",
      runtime: "45m",
      released: "2019-01-01T00:00:00.000Z",
      director: ["Someone"],
      cast: ["A", "B", "C", "D", "E"],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("User-Agent")).toMatch(
      /^Stremlist\//,
    );
  });

  it("asks only Cinemeta when IMDb is turned off", async () => {
    const id = freshId();
    process.env.DISABLED_PROVIDERS = "imdb";
    try {
      await enrichTitles([{ imdbId: id, type: "movie" }]);
    } finally {
      delete process.env.DISABLED_PROVIDERS;
    }

    expect(scraperMocks.fetchTitlesByIds).not.toHaveBeenCalled();
    expect(requestedUrls()).toEqual([cinemetaUrl("movie", id)]);
  });

  it("asks Cinemeta only for Titles that IMDb did not answer", async () => {
    const [fromImdb, missing] = [freshId(), freshId()];
    scraperMocks.fetchTitlesByIds.mockResolvedValue(
      new Map([[fromImdb, meta(fromImdb)]]),
    );
    fetchMock.mockResolvedValue(
      Response.json({ meta: { name: "From Cinemeta" } }),
    );

    const result = await enrichTitles([
      { imdbId: fromImdb, type: "movie" },
      { imdbId: missing, type: "movie" },
    ]);

    expect(requestedUrls()).toEqual([cinemetaUrl("movie", missing)]);
    expect(result.get(missing)?.name).toBe("From Cinemeta");
  });

  it("tries movie then series when the type is unknown", async () => {
    const id = freshId();
    scraperMocks.fetchTitlesByIds.mockRejectedValue(new Error("IMDb 503"));
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        urlOf(url) === cinemetaUrl("series", id)
          ? Response.json({ meta: { name: "A series" } })
          : Response.json({ meta: null }),
      ),
    );

    const result = await enrichTitles([{ imdbId: id }]);

    expect(requestedUrls()).toEqual([
      cinemetaUrl("movie", id),
      cinemetaUrl("series", id),
    ]);
    expect(result.get(id)).toMatchObject({ type: "series", name: "A series" });
  });

  it("leaves a Title out when nobody knows it, without throwing", async () => {
    const id = freshId();
    scraperMocks.fetchTitlesByIds.mockRejectedValue(new Error("IMDb 503"));
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await enrichTitles([{ imdbId: id, type: "movie" }]);

    expect(result.has(id)).toBe(false);
  });
});
