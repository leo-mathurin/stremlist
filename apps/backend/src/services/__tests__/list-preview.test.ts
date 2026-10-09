import type { CatalogPreview } from "@stremlist/shared/catalog-preview";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enrichMocks = vi.hoisted(() => ({
  enrichTitles: vi.fn(),
}));

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});
vi.mock("../list-cache", async () => {
  const cache = await import("../../__tests__/helpers/mock-list-cache");
  return { ...cache, writeCachedList: vi.fn(cache.writeCachedList) };
});
vi.mock("../../providers/registry", async () => {
  return await import("../../__tests__/helpers/mock-registry");
});
vi.mock("../../titles/enrich", () => enrichMocks);

import {
  movie,
  seedAccount,
  seedConnection,
} from "../../__tests__/helpers/fixtures";
import { cache } from "../../__tests__/helpers/mock-list-cache";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import { db } from "../../__tests__/helpers/mock-supabase";
import type { SourceEntry } from "../../providers/types";
import {
  ConnectionExpiredError,
  SourceUnavailableError,
} from "../../providers/types";
import * as listCache from "../list-cache";
import type { PreviewRequest } from "../list-preview";
import {
  previewList,
  previewPoster,
  resetPreviewReadings,
} from "../list-preview";

const MOVIES = [
  movie("tt0000001", {
    name: "Charlie",
    imdbRating: "6.1",
    runtime: "1h 50min",
    releaseInfo: "1999",
  }),
  movie("tt0000002", {
    name: "Alpha",
    imdbRating: "8.4",
    runtime: "85min",
    releaseInfo: "2004",
  }),
  movie("tt0000003", {
    name: "Bravo",
    imdbRating: "7.2",
    runtime: "1h 20min",
    releaseInfo: "2012",
  }),
];
const SERIES = [movie("tt0000004", { type: "series", name: "Delta" })];

function entries(metas: StremioMeta[]): SourceEntry[] {
  return metas.map((item) => ({
    imdbId: item.id,
    type: item.type,
    meta: item,
  }));
}

function request(overrides: Partial<PreviewRequest> = {}): PreviewRequest {
  return {
    connectionAccountId: null,
    provider: "trakt",
    sourceRef: "users/someone/lists/favorites",
    sortOption: "added_at-asc",
    displayMode: "split",
    ...overrides,
  };
}

/** A preview that must succeed. */
async function previewOk(req: PreviewRequest): Promise<CatalogPreview> {
  const preview = await previewList(req);
  if (!preview.ok) throw new Error(`Preview refused: ${preview.reason}`);
  return preview;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  cache.reset();
  resetProviders();
  resetPreviewReadings();
  enrichMocks.enrichTitles.mockResolvedValue(new Map());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("previewList: Catalogs", () => {
  it("shows one Catalog per type for a split List, in the saved sort", async () => {
    useFakeProvider(
      fakeAdapter("trakt", { entries: entries([...MOVIES, ...SERIES]) }),
    );

    const preview = await previewOk(request({ sortOption: "title-asc" }));

    expect(preview).toMatchObject({
      ok: true,
      titleCount: 4,
      typeCounts: { movie: 3, series: 1 },
    });
    expect(
      preview.catalogs.map(({ type, preset, total, titles }) => ({
        type,
        preset,
        total,
        names: titles.map((title) => title.name),
      })),
    ).toEqual([
      {
        type: "movie",
        preset: null,
        total: 3,
        names: ["Alpha", "Bravo", "Charlie"],
      },
      { type: "series", preset: null, total: 1, names: ["Delta"] },
    ]);
  });

  it("applies the List's filters and adds a Catalog for each preset", async () => {
    useFakeProvider(fakeAdapter("trakt", { entries: entries(MOVIES) }));

    const preview = await previewOk(
      request({
        displayMode: "movie",
        catalogSettings: { minRating: 7, presets: ["short", "rated"] },
      }),
    );
    expect(
      preview.catalogs.map(({ preset, total, titles }) => ({
        preset,
        total,
        ids: titles.map((title) => title.id),
      })),
    ).toEqual([
      // Rating 7+, Source list order.
      { preset: null, total: 2, ids: ["tt0000002", "tt0000003"] },
      // Also 90 minutes or less.
      { preset: "short", total: 2, ids: ["tt0000002", "tt0000003"] },
      // Top rated sorts by rating.
      { preset: "rated", total: 2, ids: ["tt0000002", "tt0000003"] },
    ]);
  });

  it("shows only the Catalog of the chosen type, empty when no Title matches, and counts the other type", async () => {
    useFakeProvider(fakeAdapter("trakt", { entries: entries(MOVIES) }));

    const preview = await previewOk(request({ displayMode: "series" }));
    expect(preview.catalogs).toEqual([
      { type: "series", preset: null, total: 0, titles: [] },
    ]);
    expect(preview.typeCounts).toEqual({ movie: 3, series: 0 });
  });

  it("shows at most 12 Titles per Catalog, with the full count", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      movie(`tt${String(index + 1).padStart(7, "0")}`),
    );
    useFakeProvider(fakeAdapter("trakt", { entries: entries(many) }));

    const preview = await previewOk(request({ displayMode: "movie" }));
    expect(preview.catalogs[0].total).toBe(30);
    expect(preview.catalogs[0].titles).toHaveLength(12);
    expect(preview.catalogs[0].titles[0]).toEqual({
      id: "tt0000001",
      type: "movie",
      name: "Movie tt0000001",
      poster: null,
      releaseInfo: null,
    });
  });

  it("writes no Catalog cache", async () => {
    useFakeProvider(fakeAdapter("trakt", { entries: entries(MOVIES) }));

    await previewList(request());

    expect(listCache.writeCachedList).not.toHaveBeenCalled();
  });
});

describe("previewList: Unresolved entries", () => {
  it("lists the entries without an IMDb ID, with a page about each when known", async () => {
    const resolvedMeta = movie("tt0137523", { name: "Fight Club" });
    enrichMocks.enrichTitles.mockResolvedValue(
      new Map([[resolvedMeta.id, resolvedMeta]]),
    );
    useFakeProvider(
      fakeAdapter("senscritique", {
        entries: [
          { imdbId: "tt0137523", type: "movie" },
          {
            type: "movie",
            title: "Le Film Inconnu",
            year: 2004,
            externalIds: { justwatchPath: "/fr/film/le-film-inconnu" },
          },
          {
            type: "series",
            originalTitle: "Original Only",
            externalIds: { tmdb: { id: 42, type: "series" } },
          },
          // The Provider's own page comes first.
          {
            title: "On Simkl",
            sourceUrl: "https://simkl.com/movies/1/on-simkl",
            externalIds: { tmdb: { id: 1, type: "movie" } },
          },
          { title: "Nothing known" },
        ],
      }),
    );

    const preview = await previewOk(
      request({ provider: "senscritique", sourceRef: "lists/1" }),
    );
    expect(preview.titleCount).toBe(1);
    expect(preview.unresolved).toEqual({
      count: 4,
      notCheckedYet: 0,
      entries: [
        {
          title: "Le Film Inconnu",
          year: 2004,
          type: "movie",
          url: "https://www.justwatch.com/fr/film/le-film-inconnu",
        },
        {
          title: "Original Only",
          year: null,
          type: "series",
          url: "https://www.themoviedb.org/tv/42",
        },
        {
          title: "On Simkl",
          year: null,
          type: "movie",
          url: "https://simkl.com/movies/1/on-simkl",
        },
        { title: "Nothing known", year: null, type: null, url: null },
      ],
    });
  });

  it("lists at most 50 Unresolved entries, with the full count", async () => {
    useFakeProvider(
      fakeAdapter("senscritique", {
        entries: Array.from({ length: 60 }, (_, index) => ({
          title: `Entry ${index}`,
        })),
      }),
    );

    const preview = await previewOk(
      request({ provider: "senscritique", sourceRef: "lists/2" }),
    );
    expect(preview.unresolved.count).toBe(60);
    expect(preview.unresolved.entries).toHaveLength(50);
    expect(preview.unresolved.entries[0].title).toBe("Entry 0");
  });

  it("counts Titles that have an IMDb ID but no details", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [{ imdbId: "tt0000009", type: "movie" }],
      }),
    );

    const preview = await previewOk(request());
    expect(preview.titleCount).toBe(0);
    expect(preview.withoutDetails).toBe(1);
  });
});

describe("previewList: problems", () => {
  it("explains a private Source list", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () =>
          Promise.reject(new SourceUnavailableError("private", "private")),
      }),
    );

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "private",
    });
  });

  it("asks for a Connection without reading when the request may not use one", async () => {
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    await expect(
      previewList(request({ sourceRef: "me/history" })),
    ).resolves.toEqual({ ok: false, reason: "needs_connection" });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("asks to connect again when the Connection expired", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () => Promise.reject(new ConnectionExpiredError("trakt")),
      }),
    );

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "needs_connection",
    });
  });

  it("reads nothing from a Provider that is turned off", async () => {
    process.env.DISABLED_PROVIDERS = "trakt";
    const fetchSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("says a Provider is coming soon without reading it", async () => {
    await expect(
      previewList(
        request({ provider: "letterboxd", sourceRef: "leo/watchlist" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "coming_soon" });
  });

  it("reports an unexpected failure as unavailable, and reads again next time", async () => {
    const fetchSource = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ entries: entries(MOVIES) });
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(previewList(request())).resolves.toMatchObject({
      ok: true,
      titleCount: 3,
    });
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });
});

describe("previewList: reads", () => {
  it("reuses one read when only the sort or the filters change", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({ entries: entries(MOVIES) }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    await previewList(request());
    const sorted = await previewOk(
      request({ sortOption: "rating-desc", catalogSettings: { minRating: 7 } }),
    );

    expect(fetchSource).toHaveBeenCalledOnce();
    expect(sorted.catalogs[0].titles.map((title) => title.name)).toEqual([
      "Alpha",
      "Bravo",
    ]);
  });

  it("never shares a read through a Connection with another Account or a public request", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({ entries: entries(MOVIES) }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    const owner = seedAccount();
    seedConnection(owner.id, "trakt");
    const other = seedAccount();
    seedConnection(other.id, "trakt");
    const ref = { sourceRef: "users/owner/lists/private-list" };

    await previewList(request({ ...ref, connectionAccountId: owner.id }));
    await previewList(request({ ...ref, connectionAccountId: other.id }));
    await previewList(request(ref));

    expect(fetchSource).toHaveBeenCalledTimes(3);
    expect(fetchSource).toHaveBeenLastCalledWith(ref.sourceRef, {
      connection: null,
    });
  });

  it("reads again after the Account connects the Provider again", async () => {
    const fetchSource = vi.fn(() =>
      Promise.resolve({ entries: entries(MOVIES) }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));
    const account = seedAccount();
    seedConnection(account.id, "trakt", { accessToken: "first-user" });
    const history = request({
      sourceRef: "me/history",
      connectionAccountId: account.id,
    });

    await previewList(history);
    await previewList(history);
    expect(fetchSource).toHaveBeenCalledOnce();

    // A new authorization, for example as another Trakt user.
    const connections = db.getTable("connections");
    connections.splice(0, connections.length);
    seedConnection(account.id, "trakt", { accessToken: "second-user" });
    await previewList(history);

    expect(fetchSource).toHaveBeenCalledTimes(2);
  });

  it("reads the Source list again after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchSource = vi.fn(() =>
      Promise.resolve({ entries: entries(MOVIES) }),
    );
    useFakeProvider(fakeAdapter("trakt", { fetchSource }));

    await previewList(request());
    vi.advanceTimersByTime(60_000);
    await previewList(request());
    expect(fetchSource).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5 * 60_000);
    await previewList(request());
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });

  it("reads again after 30 seconds when entries were not checked yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // More entries than one refresh sends through the strategies.
    const unknown = Array.from(
      { length: 301 },
      (_, index): SourceEntry => ({
        type: "movie",
        externalIds: { tmdb: { id: index + 1, type: "movie" } },
      }),
    );
    const fetchSource = vi.fn(() => Promise.resolve({ entries: unknown }));
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource,
        resolutionKey: (entry) => ({
          namespace: "tmdb:movie",
          externalId: String(entry.externalIds?.tmdb?.id),
        }),
        resolverStrategies: [
          { name: "none", resolve: () => Promise.resolve(new Map()) },
        ],
      }),
    );

    const first = await previewOk(request());
    expect(first.unresolved).toMatchObject({ count: 301, notCheckedYet: 1 });

    vi.advanceTimersByTime(31_000);
    await previewList(request());
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });
});

describe("previewList: merged Lists", () => {
  const IMDB = { provider: "imdb", sourceRef: "ur1000001" } as const;

  function dated(metas: StremioMeta[], dates: string[]): SourceEntry[] {
    return entries(metas).map((entry, index) => ({
      ...entry,
      addedAt: dates[index],
    }));
  }

  it("shows the Titles of every Source list once, with all their Unresolved entries", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [
          ...entries([MOVIES[0], MOVIES[1]]),
          { title: "Lost film", year: 1970, type: "movie" },
        ],
      }),
    );
    useFakeProvider(
      fakeAdapter("imdb", {
        entries: [
          ...entries([MOVIES[1], MOVIES[2], ...SERIES]),
          { title: "Lost show", year: 1980, type: "series" },
        ],
      }),
    );

    const preview = await previewOk(
      request({ mergedSources: [IMDB], sortOption: "title-asc" }),
    );

    expect(preview.titleCount).toBe(4);
    expect(preview.typeCounts).toEqual({ movie: 3, series: 1 });
    expect(preview.catalogs[0].titles.map((title) => title.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(preview.catalogs[1].titles.map((title) => title.name)).toEqual([
      "Delta",
    ]);
    expect(preview.unresolved.count).toBe(2);
    expect(preview.unresolved.entries.map((entry) => entry.title)).toEqual([
      "Lost film",
      "Lost show",
    ]);
    expect(preview.sourceProblems).toBeUndefined();
  });

  it("sorts the Source lists together by date added, like the Catalog", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: dated(
          [MOVIES[0], MOVIES[1]],
          ["2021-01-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z"],
        ),
      }),
    );
    useFakeProvider(
      fakeAdapter("imdb", {
        entries: dated(
          [MOVIES[2], MOVIES[0]],
          ["2022-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"],
        ),
      }),
    );

    const preview = await previewOk(
      request({ mergedSources: [IMDB], sortOption: "added_at-asc" }),
    );

    // Charlie keeps its first date (2021).
    expect(preview.catalogs[0].titles.map((title) => title.name)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
    ]);
  });

  it("leaves out a Source list that cannot be read and says why", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () =>
          Promise.reject(new SourceUnavailableError("private", "private")),
      }),
    );
    useFakeProvider(fakeAdapter("imdb", { entries: entries([MOVIES[2]]) }));

    const preview = await previewOk(request({ mergedSources: [IMDB] }));

    expect(preview.titleCount).toBe(1);
    expect(preview.sourceProblems).toEqual([
      {
        provider: "trakt",
        sourceRef: "users/someone/lists/favorites",
        reason: "private",
      },
    ]);
  });

  it("does not read a merged Source list that needs a Connection the request may not use", async () => {
    const traktRead = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { fetchSource: traktRead }));
    useFakeProvider(fakeAdapter("imdb", { entries: entries([MOVIES[2]]) }));

    const preview = await previewOk(
      request({
        ...IMDB,
        mergedSources: [{ provider: "trakt", sourceRef: "me/history" }],
      }),
    );

    expect(traktRead).not.toHaveBeenCalled();
    expect(preview.sourceProblems).toEqual([
      {
        provider: "trakt",
        sourceRef: "me/history",
        reason: "needs_connection",
      },
    ]);
  });

  it("fails when no Source list can be read, naming the first one that failed", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () =>
          Promise.reject(new SourceUnavailableError("not_found", "gone")),
      }),
    );
    process.env.DISABLED_PROVIDERS = "imdb";

    await expect(
      previewList(request({ mergedSources: [IMDB] })),
    ).resolves.toEqual({
      ok: false,
      reason: "not_found",
      source: {
        provider: "trakt",
        sourceRef: "users/someone/lists/favorites",
      },
    });
  });
});

describe("previewPoster", () => {
  it("asks IMDb for a small image", () => {
    expect(
      previewPoster(
        "https://m.media-amazon.com/images/M/MV5BMGRiOWQy@._V1_.jpg",
      ),
    ).toBe(
      "https://m.media-amazon.com/images/M/MV5BMGRiOWQy@._V1_QL75_UX240_.jpg",
    );
    expect(
      previewPoster(
        "https://m.media-amazon.com/images/M/MV5BMGRiOWQy@._V1_SX300.jpg",
      ),
    ).toBe(
      "https://m.media-amazon.com/images/M/MV5BMGRiOWQy@._V1_QL75_UX240_.jpg",
    );
  });

  it("keeps other posters as they are", () => {
    expect(previewPoster("https://images.metahub.space/poster/tt1.jpg")).toBe(
      "https://images.metahub.space/poster/tt1.jpg",
    );
    expect(previewPoster(null)).toBeNull();
  });
});
