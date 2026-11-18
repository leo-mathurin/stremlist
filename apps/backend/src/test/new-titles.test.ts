import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { http, HttpResponse } from "msw";
import app from "../index.js";
import { getProvider } from "./helpers/config-api.js";
import { entryKey } from "../services/detections";
import {
  LIST_IDS,
  movie,
  seedConnection,
  seedList,
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { db } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import {
  accountId,
  DAY_MS,
  detectionRows,
  duringNextRead,
  ids,
  imdb,
  newTitles,
  newTitlesHandlers,
  NEXT_SYNC_MS,
  resetNewTitlesTest,
  restoreNewTitlesTest,
  seedImdbList,
  seedNewTitlesAccount,
  serveCutSmartList,
  sourceList,
  summary,
  sync,
  syncRows,
  testDay,
  trakt,
} from "./helpers/new-titles.js";

const server = useMswServer();
const background = useBackgroundTasks();

beforeEach(() => {
  resetNewTitlesTest();
  server.use(...newTitlesHandlers());
});
afterEach(async () => {
  await background.settle();
  restoreNewTitlesTest();
});

describe("detection", () => {
  it("uses the first complete synchronization as the Baseline", async () => {
    seedImdbList();
    sourceList("imdb", [movie("tt0000001"), movie("tt0000002")]);

    await sync(LIST_IDS[0]);

    expect(await newTitles()).toEqual([]);
    expect(detectionRows()).toHaveLength(2);
    expect(detectionRows().every((row) => row.detected_at === null)).toBe(true);
    expect((await summary()).summary).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 0,
    });
  });

  it("detects a Title that the next complete synchronization adds, dated by Stremlist", async () => {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      source_ref: "ur1",
      catalog_title: "Watchlist",
    });
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);

    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    source.metas = [
      movie("tt0000001"),
      movie("tt0000002", { description: "A plot." }),
    ];
    await sync(LIST_IDS[0]);
    const detectedAt = new Date().toISOString();

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000002"]);
    expect(metas[0].description).toBe(
      `Detected by Stremlist on ${testDay(2)} in Watchlist.\n\nA plot.`,
    );
    expect((await summary()).summary).toEqual({
      detected: 1,
      latestDetectedAt: detectedAt,
      waitingLists: 0,
    });
  });

  it("does not take a failed synchronization as a removal", async () => {
    seedImdbList();
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);

    source.down = true;
    await sync(LIST_IDS[0]);

    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);

    source.down = false;
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    expect(detectionRows()).toHaveLength(2);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);
  });

  it("does not compare a read cut by a page cap", async () => {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      provider: "trakt",
      source_ref: "smart-lists/picks",
    });
    const source = sourceList(
      "trakt",
      [movie("tt0000001"), movie("tt0000002")],
      "smart-lists/picks",
    );
    await sync(LIST_IDS[0]);

    serveCutSmartList("smart-lists/picks", [
      movie("tt0000001"),
      movie("tt0000003"),
    ]);
    await sync(LIST_IDS[0]);

    expect(await newTitles()).toEqual([]);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);

    source.metas = [movie("tt0000001"), movie("tt0000002"), movie("tt0000003")];
    vi.setSystemTime(Date.now() + DAY_MS);
    await sync(LIST_IDS[0]);
    const row = detectionRows().find((r) => r.imdb_id === "tt0000003");
    expect(row?.detected_at).toBe(new Date().toISOString());
  });

  it("keeps the first detection of a Title that is removed and added again", async () => {
    seedImdbList();
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    const firstDetection = new Date().toISOString();

    source.metas = [movie("tt0000001")];
    await sync(LIST_IDS[0]);
    expect(await newTitles()).toEqual([]);

    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    const row = detectionRows().find((r) => r.imdb_id === "tt0000002");
    expect(row).toMatchObject({
      detected_at: firstDetection,
      removed_at: null,
    });
  });

  it("keeps the history when the List is removed and added again", async () => {
    seedImdbList();
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    db.tables.lists = [];

    seedList(accountId, { id: LIST_IDS[1], source_ref: "ur1" });
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[1]);

    expect(ids(await newTitles())).toEqual(["tt0000002"]);
  });
});

const TMDB_API = "https://api.themoviedb.org/3";

function resolvingSourceList() {
  vi.stubEnv("TMDB_API_KEY", "tmdb-key");
  const state = {
    entries: [] as TraktEntry[],
    known: new Map<number, string>(),
  };
  const serve = () => {
    trakt.paths.set(
      "/users/leo/watchlist",
      state.entries.map(({ trakt: id, tmdb, title }) => ({
        type: "movie",
        movie: { title, ids: { trakt: id, ...(tmdb ? { tmdb } : {}) } },
      })),
    );
  };
  server.use(
    http.get(`${TMDB_API}/movie/:id/external_ids`, ({ params }) => {
      const imdbId = state.known.get(Number(params.id));
      return HttpResponse.json({ imdb_id: imdbId ?? null });
    }),
  );
  return {
    get entries() {
      return state.entries;
    },
    set entries(next: TraktEntry[]) {
      state.entries = next;
      serve();
    },
    known: state.known,
  };
}

interface TraktEntry {
  trakt: number;
  tmdb?: number;
  title: string;
}

function providerEntry(id: number, imdbId: string) {
  imdb.titles.set(imdbId, movie(imdbId));
  const entry: TraktEntry = { trakt: id, tmdb: id, title: `Entry ${id}` };
  return entry;
}

const NEVER_RESOLVED: TraktEntry = { trakt: 999, title: "Never on IMDb" };

describe("Unresolved entries", () => {
  const AFTER_RETRY_MS = 25 * 60 * 60_000;

  function seedTraktList() {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      provider: "trakt",
      source_ref: "users/leo/watchlist",
      catalog_title: "Trakt watchlist",
    });
  }

  it("do not block the Baseline or the detection of other entries", async () => {
    seedTraktList();
    const source = resolvingSourceList();
    source.known.set(1, "tt0000001").set(2, "tt0000002");
    source.entries = [providerEntry(1, "tt0000001"), NEVER_RESOLVED];
    await sync(LIST_IDS[0]);

    expect(syncRows()).toHaveLength(1);
    expect((await summary()).summary?.waitingLists).toBe(0);

    source.entries = [...source.entries, providerEntry(2, "tt0000002")];
    await sync(LIST_IDS[0]);

    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    const never = detectionRows().find(
      (row) => row.entry_key === "trakt-movie:999",
    );
    expect(never).toMatchObject({ imdb_id: null, removed_at: null });
  });

  it("are not new when they resolve later: they were already there", async () => {
    seedTraktList();
    const source = resolvingSourceList();
    source.known.set(1, "tt0000001");
    source.entries = [
      providerEntry(1, "tt0000001"),
      providerEntry(3, "tt0000003"),
      NEVER_RESOLVED,
    ];
    await sync(LIST_IDS[0]);

    source.known.set(3, "tt0000003");
    vi.setSystemTime(Date.now() + AFTER_RETRY_MS);
    await sync(LIST_IDS[0]);

    expect(await newTitles()).toEqual([]);
    const row = detectionRows().find((r) => r.entry_key === "trakt-movie:3");
    expect(row).toMatchObject({ imdb_id: "tt0000003", detected_at: null });
  });

  it("keep the date of their first appearance when a new one resolves later", async () => {
    seedTraktList();
    const source = resolvingSourceList();
    source.known.set(1, "tt0000001");
    source.entries = [providerEntry(1, "tt0000001"), NEVER_RESOLVED];
    await sync(LIST_IDS[0]);

    source.entries = [...source.entries, providerEntry(4, "tt0000004")];
    await sync(LIST_IDS[0]);
    const firstSeen = new Date().toISOString();
    expect(await newTitles()).toEqual([]);

    source.known.set(4, "tt0000004");
    vi.setSystemTime(Date.now() + AFTER_RETRY_MS);
    await sync(LIST_IDS[0]);

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000004"]);
    expect(metas[0].description).toBe(
      `Detected by Stremlist on ${testDay(0)} in Trakt watchlist.`,
    );
    const row = detectionRows().find((r) => r.entry_key === "trakt-movie:4");
    expect(row).toMatchObject({ imdb_id: "tt0000004", detected_at: firstSeen });
  });

  it("are followed by title and year when the Provider gives no ID", () => {
    const adapter = getProvider("imdb");
    expect(entryKey(adapter, { title: "Amélie!", year: 2001 })).toBe(
      "title:amelie:2001",
    );
    expect(entryKey(adapter, { imdbId: "tt0211915", title: "Amélie" })).toBe(
      "imdb:tt0211915",
    );
    expect(entryKey(adapter, { type: "movie" })).toBeNull();
  });
});

describe("overlapping reads and Connections", () => {
  it("dates a synchronization by the start of its read", async () => {
    seedImdbList();
    sourceList("imdb", [movie("tt0000001")]);
    duringNextRead(() => {
      vi.setSystemTime(Date.now() + 10 * 60_000);
    });
    vi.setSystemTime(Date.now() + NEXT_SYNC_MS);
    const startedAt = new Date().toISOString();
    await app.request(
      `/${accountId}/catalog/movie/wl-${LIST_IDS[0]}-movie.json`,
    );

    expect(syncRows()[0]).toMatchObject({
      last_complete_sync_at: startedAt,
    });
  });

  it("records nothing when the Connection is gone before the read ends", async () => {
    seedNewTitlesAccount();
    seedConnection(accountId, "trakt", { username: "leo" });
    seedList(accountId, {
      id: LIST_IDS[0],
      provider: "trakt",
      source_ref: "me/history",
    });
    sourceList("trakt", [movie("tt0000001")], "me/history");
    duringNextRead(() => {
      db.tables.connections = [];
    });

    await sync(LIST_IDS[0]);

    expect(syncRows()).toEqual([]);
    expect(detectionRows()).toEqual([]);
  });

  it("starts a new Baseline when the Connection is another Provider user", async () => {
    seedNewTitlesAccount();
    seedConnection(accountId, "trakt", { username: "leo" });
    seedList(accountId, {
      id: LIST_IDS[0],
      provider: "trakt",
      source_ref: "me/history",
      catalog_title: "History",
    });
    const source = sourceList("trakt", [movie("tt0000001")], "me/history");
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);

    db.getTable("connections")[0].provider_username = "sam";
    source.metas = [movie("tt0000001"), movie("tt0000002"), movie("tt0000003")];
    await sync(LIST_IDS[0]);

    expect(await newTitles()).toEqual([]);
    expect(syncRows()).toMatchObject([
      { source_ref: "me/history", connection_user: "sam" },
    ]);
    expect(detectionRows().every((row) => row.detected_at === null)).toBe(true);
  });
});
