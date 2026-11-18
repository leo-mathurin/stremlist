import type { ListSource } from "@stremlist/shared/list-merge";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  movie,
  seedAccount,
  seedConnection,
} from "../../test/helpers/account.fixture";
import { cache } from "../../test/helpers/list-cache.test-utils";
import { db, resetRpc } from "../../test/helpers/mock-supabase";
import {
  cinemetaWithoutTitles,
  FakeImdb,
} from "../../test/helpers/imdb.test-utils";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { r2Objects, resetR2 } from "../../test/helpers/r2.test-utils";
import {
  FakeSensCritique,
  senscritiqueProduct,
} from "../../test/helpers/senscritique.test-utils";
import {
  FakeTrakt,
  traktItems,
  useTraktApp,
} from "../../test/helpers/trakt.test-utils";
import { TRAKT_API } from "../../providers/trakt/api";
import type { SourceEntry } from "../../providers/types";
import * as listCache from "../list-cache";
import type { PreviewRequest } from "../list-preview";
import {
  previewList,
  previewPoster,
  resetPreviewReadings,
  toUnresolvedEntry,
} from "../list-preview";

const imdb = new FakeImdb();
const trakt = new FakeTrakt();
const senscritique = new FakeSensCritique();
const server = useMswServer();
const writeCachedList = vi.spyOn(listCache, "writeCachedList");

const FAVORITES = "users/someone/lists/favorites";
const ITEMS = `/${FAVORITES}/items`;
const HISTORY = ["/users/me/watched/movies", "/users/me/watched/shows"];

const MOVIES = [
  movie("tt0000001", {
    name: "Charlie",
    imdbRating: "6.1",
    releaseInfo: "1999",
    runtime: "1h 50m",
  }),
  movie("tt0000002", {
    name: "Alpha",
    imdbRating: "8.4",
    releaseInfo: "2004",
    runtime: "1h 25m",
  }),
  movie("tt0000003", {
    name: "Bravo",
    imdbRating: "7.2",
    releaseInfo: "2012",
    runtime: "1h 20m",
  }),
];
const SERIES = [movie("tt0000004", { type: "series", name: "Delta" })];

function knownTitles(metas: StremioMeta[]) {
  for (const meta of metas) imdb.titles.set(meta.id, meta);
}

function serveTrakt(metas: StremioMeta[], path = ITEMS) {
  trakt.serve(path, metas);
  knownTitles(metas);
}

function serveHistory(metas: StremioMeta[]) {
  serveTrakt(metas, HISTORY[0]);
  trakt.serve(HISTORY[1], []);
}

function reads(path = ITEMS) {
  return trakt
    .requestsOf(path)
    .filter((request) => request.query.get("page") === "1");
}

function unresolvedTitle(namespace: string, externalId: number) {
  db.insert("title_id_map", {
    namespace,
    external_id: String(externalId),
    imdb_id: null,
    retry_after: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  });
}

function request(overrides: Partial<PreviewRequest> = {}) {
  const value: PreviewRequest = {
    connectionAccountId: null,
    provider: "trakt",
    sourceRef: FAVORITES,
    sortOption: "added_at-asc",
    displayMode: "split",
    ...overrides,
  };
  return value;
}

async function previewOk(req: PreviewRequest) {
  const preview = await previewList(req);
  if (!preview.ok) throw new Error(`Preview refused: ${preview.reason}`);
  return preview;
}

let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 10 * 60_000;
  vi.setSystemTime(clock);
  vi.clearAllMocks();
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
  vi.stubEnv("TMDB_API_KEY", "");
  useTraktApp();
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  resetPreviewReadings();
  imdb.reset();
  trakt.reset();
  senscritique.reset();
  server.use(
    imdb.handler,
    trakt.handler,
    senscritique.handler,
    cinemetaWithoutTitles,
  );
});
afterEach(() => {
  clock = Date.now();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("previewList: Catalogs", () => {
  it("shows one Catalog per type for a split List, in the saved sort", async () => {
    serveTrakt([...MOVIES, ...SERIES]);

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
    serveTrakt(MOVIES);

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
      { preset: null, total: 2, ids: ["tt0000002", "tt0000003"] },
      { preset: "short", total: 2, ids: ["tt0000002", "tt0000003"] },
      { preset: "rated", total: 2, ids: ["tt0000002", "tt0000003"] },
    ]);
  });

  it("shows only the Catalog of the chosen type, empty when no Title matches, and counts the other type", async () => {
    serveTrakt(MOVIES);

    const preview = await previewOk(request({ displayMode: "series" }));
    expect(preview.catalogs).toEqual([
      { type: "series", preset: null, total: 0, titles: [] },
    ]);
    expect(preview.typeCounts).toEqual({ movie: 3, series: 0 });
  });

  it("shows at most 12 Titles per Catalog, with the full count", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      movie(`tt${String(index + 1001).padStart(7, "0")}`),
    );
    serveTrakt(many);

    const preview = await previewOk(request({ displayMode: "movie" }));
    expect(preview.catalogs[0].total).toBe(30);
    expect(preview.catalogs[0].titles).toHaveLength(12);
    expect(preview.catalogs[0].titles[0]).toEqual({
      id: "tt0001001",
      type: "movie",
      name: "Movie tt0001001",
      poster: null,
      tmdbPoster: null,
      tvdbPoster: null,
      releaseInfo: null,
    });
  });

  it("writes no Catalog cache", async () => {
    serveTrakt(MOVIES);

    await previewOk(request());

    expect(writeCachedList).not.toHaveBeenCalled();
    expect(
      [...r2Objects.keys()].filter((key) => key.startsWith("watchlists/")),
    ).toEqual([]);
  });
});

describe("previewList: Unresolved entries", () => {
  it("lists the entries without an IMDb ID, with a page about each when known", async () => {
    const resolvedMeta = movie("tt0137523", { name: "Fight Club" });
    knownTitles([resolvedMeta]);
    db.insert("title_id_map", {
      namespace: "senscritique",
      external_id: "1001",
      imdb_id: resolvedMeta.id,
    });
    for (const id of [1002, 1003, 1004]) unresolvedTitle("senscritique", id);
    senscritique.lists.set(1, [
      senscritiqueProduct(1001, { title: "Fight Club" }),
      senscritiqueProduct(1002, {
        title: "Le Film Inconnu",
        yearOfProduction: 2004,
        dateRelease: null,
        providers: [
          { justwatchUrl: "https://www.justwatch.com/fr/film/le-film-inconnu" },
        ],
      }),
      senscritiqueProduct(1003, {
        type: "series",
        title: null,
        originalTitle: "Original Only",
        yearOfProduction: null,
        dateRelease: null,
      }),
      senscritiqueProduct(1004, {
        title: "Nothing known",
        yearOfProduction: null,
        dateRelease: null,
      }),
    ]);
    trakt.serveItems(ITEMS, [
      {
        type: "show",
        show: { title: "On TMDB", year: 2010, ids: { tmdb: 42 } },
      },
    ]);

    const preview = await previewOk(
      request({
        provider: "senscritique",
        sourceRef: "lists/1",
        mergedSources: [{ provider: "trakt", sourceRef: FAVORITES }],
      }),
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
        { title: "Original Only", year: null, type: "series", url: null },
        { title: "Nothing known", year: null, type: "movie", url: null },
        {
          title: "On TMDB",
          year: 2010,
          type: "series",
          url: "https://www.themoviedb.org/tv/42",
        },
      ],
    });
  });

  it("shows each kind of Unresolved entry with the best page about it", () => {
    const entries: SourceEntry[] = [
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
      {
        title: "On Simkl",
        sourceUrl: "https://simkl.com/movies/1/on-simkl",
        externalIds: { tmdb: { id: 1, type: "movie" } },
      },
      { title: "Nothing known" },
    ];

    expect(entries.map(toUnresolvedEntry)).toEqual([
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
    ]);
  });

  it("lists at most 50 Unresolved entries, with the full count", async () => {
    const products = Array.from({ length: 60 }, (_, index) => {
      unresolvedTitle("senscritique", 2000 + index);
      return senscritiqueProduct(2000 + index, { title: `Entry ${index}` });
    });
    senscritique.lists.set(2, products);

    const preview = await previewOk(
      request({ provider: "senscritique", sourceRef: "lists/2" }),
    );
    expect(preview.unresolved.count).toBe(60);
    expect(preview.unresolved.entries).toHaveLength(50);
    expect(preview.unresolved.entries[0].title).toBe("Entry 0");
  });

  it("counts Titles that have an IMDb ID but no details", async () => {
    trakt.serve(ITEMS, [movie("tt0000009")]);

    const preview = await previewOk(request());
    expect(preview.titleCount).toBe(0);
    expect(preview.withoutDetails).toBe(1);
  });
});

describe("previewList: problems", () => {
  it("explains a private Source list", async () => {
    trakt.fail(ITEMS, 401);

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "private",
    });
  });

  it("asks for a Connection without reading when the request may not use one", async () => {
    serveHistory(MOVIES);

    await expect(
      previewList(request({ sourceRef: "me/history" })),
    ).resolves.toEqual({ ok: false, reason: "needs_connection" });
    expect(trakt.requests).toEqual([]);
  });

  it("asks to connect again when the Connection expired", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt", {
      refreshToken: null,
      expiresAt: new Date(Date.now() - 60_000),
    });
    serveHistory(MOVIES);

    await expect(
      previewList(
        request({ sourceRef: "me/history", connectionAccountId: account.id }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "needs_connection",
    });
    expect(trakt.requests).toEqual([]);
  });

  it("reads nothing from a Provider that is turned off", async () => {
    vi.stubEnv("DISABLED_PROVIDERS", "trakt");
    serveTrakt(MOVIES);

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(trakt.requests).toEqual([]);
  });

  it("reports an unexpected failure as unavailable, and reads again next time", async () => {
    knownTitles(MOVIES);
    const items = `${TRAKT_API}${ITEMS}`;
    let count = 0;
    server.use(
      http.get(
        items,
        () => {
          count += 1;
          return HttpResponse.error();
        },
        { once: true },
      ),
      http.get(items, () => {
        count += 1;
        return HttpResponse.json(traktItems(MOVIES));
      }),
    );

    await expect(previewList(request())).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(previewList(request())).resolves.toMatchObject({
      ok: true,
      titleCount: 3,
    });
    expect(count).toBe(2);
  });
});

describe("previewList: reads", () => {
  it("reuses one read when only the sort or the filters change", async () => {
    serveTrakt(MOVIES);

    await previewList(request());
    const sorted = await previewOk(
      request({ sortOption: "rating-desc", catalogSettings: { minRating: 7 } }),
    );

    expect(reads()).toHaveLength(1);
    expect(sorted.catalogs[0].titles.map((title) => title.name)).toEqual([
      "Alpha",
      "Bravo",
    ]);
  });

  it("never shares a read through a Connection with another Account or a public request", async () => {
    const path = "/users/owner/lists/private-list/items";
    serveTrakt(MOVIES, path);
    const owner = seedAccount();
    seedConnection(owner.id, "trakt", { accessToken: "owner-token" });
    const other = seedAccount();
    seedConnection(other.id, "trakt", { accessToken: "other-token" });
    const ref = { sourceRef: "users/owner/lists/private-list" };

    await previewList(request({ ...ref, connectionAccountId: owner.id }));
    await previewList(request({ ...ref, connectionAccountId: other.id }));
    await previewList(request(ref));

    expect(reads(path).map((read) => read.token)).toEqual([
      "owner-token",
      "other-token",
      null,
    ]);
  });

  it("reads again after the Account connects the Provider again", async () => {
    serveHistory(MOVIES);
    const account = seedAccount();
    seedConnection(account.id, "trakt", { accessToken: "first-user" });
    const history = request({
      sourceRef: "me/history",
      connectionAccountId: account.id,
    });

    await previewList(history);
    await previewList(history);
    expect(reads(HISTORY[0]).map((read) => read.token)).toEqual(["first-user"]);

    const connections = db.getTable("connections");
    connections.splice(0, connections.length);
    seedConnection(account.id, "trakt", { accessToken: "second-user" });
    await previewList(history);

    expect(reads(HISTORY[0]).map((read) => read.token)).toEqual([
      "first-user",
      "second-user",
    ]);
  });

  it("reads the Source list again after five minutes", async () => {
    serveTrakt(MOVIES);

    await previewList(request());
    vi.advanceTimersByTime(60_000);
    await previewList(request());
    expect(reads()).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000);
    await previewList(request());
    expect(reads()).toHaveLength(2);
  });

  it("reads again after 30 seconds when entries were not checked yet", async () => {
    trakt.serveItems(
      ITEMS,
      Array.from({ length: 301 }, (_, index) => ({
        type: "movie",
        movie: { ids: { trakt: index + 1, tmdb: index + 1 } },
      })),
    );

    const first = await previewOk(request());
    expect(first.unresolved).toMatchObject({ count: 301, notCheckedYet: 1 });

    vi.advanceTimersByTime(31_000);
    await previewList(request());
    expect(reads()).toHaveLength(2);
  });
});

describe("previewList: merged Lists", () => {
  const IMDB = { provider: "imdb", sourceRef: "ur1000001" } as const;
  const OTHER: ListSource = {
    provider: "trakt",
    sourceRef: "users/someone/lists/other",
  };

  function dated(metas: StremioMeta[], dates: string[]) {
    knownTitles(metas);
    return traktItems(metas).map((item, index) => ({
      ...item,
      listed_at: dates[index],
    }));
  }

  it("shows the Titles of every Source list once, with all their Unresolved entries", async () => {
    knownTitles([...MOVIES, ...SERIES]);
    trakt.serveItems(ITEMS, [
      ...traktItems([MOVIES[0], MOVIES[1]]),
      { type: "movie", movie: { title: "Lost film", year: 1970, ids: {} } },
    ]);
    imdb.watchlists.set(IMDB.sourceRef, [MOVIES[1], MOVIES[2], ...SERIES]);
    unresolvedTitle("senscritique", 3001);
    senscritique.lists.set(3, [
      senscritiqueProduct(3001, {
        type: "series",
        title: "Lost show",
        yearOfProduction: 1980,
        dateRelease: null,
      }),
    ]);

    const preview = await previewOk(
      request({
        mergedSources: [
          IMDB,
          { provider: "senscritique", sourceRef: "lists/3" },
        ],
        sortOption: "title-asc",
      }),
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
    trakt.serveItems(
      ITEMS,
      dated(
        [MOVIES[0], MOVIES[1]],
        ["2021-01-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z"],
      ),
    );
    trakt.serveItems(
      `/${OTHER.sourceRef}/items`,
      dated(
        [MOVIES[2], MOVIES[0]],
        ["2022-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"],
      ),
    );

    const preview = await previewOk(
      request({ mergedSources: [OTHER], sortOption: "added_at-asc" }),
    );

    expect(preview.catalogs[0].titles.map((title) => title.name)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
    ]);
  });

  it("leaves out a Source list that cannot be read and says why", async () => {
    trakt.fail(ITEMS, 401);
    imdb.watchlists.set(IMDB.sourceRef, [MOVIES[2]]);
    knownTitles([MOVIES[2]]);

    const preview = await previewOk(request({ mergedSources: [IMDB] }));

    expect(preview.titleCount).toBe(1);
    expect(preview.sourceProblems).toEqual([
      {
        provider: "trakt",
        sourceRef: FAVORITES,
        reason: "private",
      },
    ]);
  });

  it("does not read a merged Source list that needs a Connection the request may not use", async () => {
    serveHistory(MOVIES);
    imdb.watchlists.set(IMDB.sourceRef, [MOVIES[2]]);
    knownTitles([MOVIES[2]]);

    const preview = await previewOk(
      request({
        ...IMDB,
        mergedSources: [{ provider: "trakt", sourceRef: "me/history" }],
      }),
    );

    expect(trakt.requests).toEqual([]);
    expect(preview.sourceProblems).toEqual([
      {
        provider: "trakt",
        sourceRef: "me/history",
        reason: "needs_connection",
      },
    ]);
  });

  it("fails when no Source list can be read, naming the first one that failed", async () => {
    trakt.fail(ITEMS, 404);
    vi.stubEnv("DISABLED_PROVIDERS", "imdb");

    await expect(
      previewList(request({ mergedSources: [IMDB] })),
    ).resolves.toEqual({
      ok: false,
      reason: "not_found",
      source: {
        provider: "trakt",
        sourceRef: FAVORITES,
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
