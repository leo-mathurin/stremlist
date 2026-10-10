import type { TitleType } from "@stremlist/shared/constants";
import { addonCatalogEntries } from "@stremlist/shared/manifest-catalogs";
import type {
  AccountConfigResponse,
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import type { SourceEntry, SourceSnapshot } from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
import { deleteConnection, saveConnection } from "../services/connections";
import { entryKey } from "../services/detections";
import { resetPreviewReadings } from "../services/list-preview";
import { sourceCaches } from "../services/merged-lists";
import {
  LIST_IDS,
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const START = new Date("2026-10-01T12:00:00.000Z");
/** More than the fake adapters' 30-minute freshness. */
const NEXT_SYNC_MS = 31 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function series(id: string): StremioMeta {
  return movie(id, { type: "series", name: `Series ${id}` });
}

function entry(meta: StremioMeta): SourceEntry {
  return { imdbId: meta.id, meta };
}

/**
 * A Source list the test changes between synchronizations. `read` decides
 * what the next read returns; by default every entry, complete.
 */
function sourceList(provider: "imdb" | "trakt", initial: StremioMeta[]) {
  const state = {
    metas: initial,
    read: null as null | (() => SourceSnapshot),
  };
  useFakeProvider(
    fakeAdapter(provider, {
      fetchSource: () =>
        Promise.resolve(
          state.read?.() ?? {
            entries: structuredClone(state.metas).map(entry),
            complete: true,
          },
        ),
    }),
  );
  return state;
}

let accountId = "";

function seedNewTitlesAccount(enabled = true) {
  accountId = seedAccount({ new_titles_catalog: enabled }).id;
}

/** An Account with one IMDb List, LIST_IDS[0] on `ur1`. */
function seedImdbList(enabled = true) {
  seedNewTitlesAccount(enabled);
  seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
}

/** Stremio asks for a List catalog after its cache went stale. */
async function sync(listId: string, type: TitleType = "movie") {
  vi.setSystemTime(Date.now() + NEXT_SYNC_MS);
  const res = await app.request(
    `/${accountId}/catalog/${type}/wl-${listId}-${type}.json`,
  );
  expect(res.status).toBe(200);
}

async function newTitles(
  type: TitleType = "movie",
  key = accountId,
): Promise<StremioMeta[]> {
  const res = await app.request(
    `/${key}/catalog/${type}/new-titles-${type}.json`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { metas: StremioMeta[] }).metas;
}

function ids(metas: StremioMeta[]): string[] {
  return metas.map((meta) => meta.id);
}

function detectionRows() {
  return db.getTable("source_list_entries");
}

async function summary() {
  const res = await app.request(`/${accountId}/config`);
  expect(res.status).toBe(200);
  return ((await res.json()) as AccountConfigResponse).newTitles;
}

/** A synchronized Source list whose entry `imdbId` was detected now. */
function seedHistory(
  provider: "imdb" | "trakt",
  sourceRef: string,
  imdbId: string,
  connectionUser: string | null = null,
) {
  const at = new Date().toISOString();
  const key = { account_id: accountId, provider, source_ref: sourceRef };
  db.insert("source_list_syncs", {
    ...key,
    baseline_at: at,
    last_complete_sync_at: at,
    requires_connection: connectionUser !== null,
    connection_user: connectionUser,
  });
  db.insert("source_list_entries", {
    ...key,
    entry_key: `imdb:${imdbId}`,
    imdb_id: imdbId,
    detected_at: at,
  });
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    // The date of the detection, not an addition date from the Provider.
    expect(metas[0].description).toBe(
      "Detected by Stremlist on 3 Oct 2026 in Watchlist.\n\nA plot.",
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

    source.read = () => {
      throw new SourceUnavailableError("unavailable", "Provider is down");
    };
    await sync(LIST_IDS[0]);

    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);

    // The next complete one is compared with the last complete one.
    source.read = null;
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    expect(detectionRows()).toHaveLength(2);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);
  });

  it("does not compare a read cut by a page cap", async () => {
    seedImdbList();
    const source = sourceList("imdb", [movie("tt0000001"), movie("tt0000002")]);
    await sync(LIST_IDS[0]);

    // The first page only, with a Title that is new.
    source.read = () => ({
      entries: [entry(movie("tt0000001")), entry(movie("tt0000003"))],
      complete: false,
    });
    await sync(LIST_IDS[0]);

    expect(await newTitles()).toEqual([]);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);

    // The next complete read detects it, at its own date.
    source.read = null;
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

    // Compared with the earlier Baseline, not taken as a new one.
    expect(ids(await newTitles())).toEqual(["tt0000002"]);
  });
});

/**
 * A Source list whose entries carry a Provider ID (the entry key) and
 * resolve through a strategy that knows only the IDs in `known`.
 */
function resolvingSourceList() {
  const state = {
    entries: [] as SourceEntry[],
    known: new Map<number, string>(),
  };
  useFakeProvider(
    fakeAdapter("trakt", {
      fetchSource: () =>
        Promise.resolve({
          entries: structuredClone(state.entries),
          complete: true,
        }),
      resolutionKey: (item) =>
        item.externalIds?.trakt === undefined
          ? null
          : { namespace: "fake", externalId: String(item.externalIds.trakt) },
      resolverStrategies: [
        {
          name: "fake",
          resolve: (items) =>
            Promise.resolve(
              new Map(
                items.flatMap((item, index) => {
                  const imdbId = state.known.get(item.externalIds?.trakt ?? -1);
                  return imdbId ? [[index, imdbId] as const] : [];
                }),
              ),
            ),
        },
      ],
    }),
  );
  return state;
}

/** An entry without an IMDb ID that the strategy resolves to `imdbId`. */
function providerEntry(trakt: number, imdbId: string): SourceEntry {
  return {
    externalIds: { trakt },
    type: "movie",
    title: `Entry ${trakt}`,
    meta: movie(imdbId),
  };
}

/** An entry that no strategy ever resolves (no IMDb entry at all). */
const NEVER_RESOLVED: SourceEntry = {
  externalIds: { trakt: 999 },
  type: "movie",
  title: "Never on IMDb",
};

describe("Unresolved entries", () => {
  // The resolver retries an Unresolved entry after 24 hours.
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

    expect(db.getTable("source_list_syncs")).toHaveLength(1);
    expect((await summary()).summary?.waitingLists).toBe(0);

    source.entries = [...source.entries, providerEntry(2, "tt0000002")];
    await sync(LIST_IDS[0]);

    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    const never = detectionRows().find((row) => row.entry_key === "fake:999");
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
    const row = detectionRows().find((r) => r.entry_key === "fake:3");
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
    // Not shown while it has no Title yet.
    expect(await newTitles()).toEqual([]);

    source.known.set(4, "tt0000004");
    vi.setSystemTime(Date.now() + AFTER_RETRY_MS);
    await sync(LIST_IDS[0]);

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000004"]);
    expect(metas[0].description).toBe(
      "Detected by Stremlist on 1 Oct 2026 in Trakt watchlist.",
    );
    const row = detectionRows().find((r) => r.entry_key === "fake:4");
    expect(row).toMatchObject({ imdb_id: "tt0000004", detected_at: firstSeen });
  });

  it("are followed by title and year when the Provider gives no ID", () => {
    const adapter = fakeAdapter("imdb");
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
    useFakeProvider(
      fakeAdapter("imdb", {
        fetchSource: () => {
          // A slow read: a newer one may start and finish meanwhile.
          vi.setSystemTime(Date.now() + 10 * 60_000);
          return Promise.resolve({
            entries: [entry(movie("tt0000001"))],
            complete: true,
          });
        },
      }),
    );
    vi.setSystemTime(Date.now() + NEXT_SYNC_MS);
    const startedAt = new Date().toISOString();
    await app.request(
      `/${accountId}/catalog/movie/wl-${LIST_IDS[0]}-movie.json`,
    );

    expect(db.getTable("source_list_syncs")[0]).toMatchObject({
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
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: () => {
          // The user disconnects while the read runs.
          db.tables.connections = [];
          return Promise.resolve({
            entries: [entry(movie("tt0000001"))],
            complete: true,
          });
        },
      }),
    );

    await sync(LIST_IDS[0]);

    expect(db.getTable("source_list_syncs")).toEqual([]);
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
    const source = sourceList("trakt", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);

    db.getTable("connections")[0].provider_username = "sam";
    source.metas = [movie("tt0000001"), movie("tt0000002"), movie("tt0000003")];
    await sync(LIST_IDS[0]);

    expect(await newTitles()).toEqual([]);
    expect(db.getTable("source_list_syncs")).toMatchObject([
      { source_ref: "me/history", connection_user: "sam" },
    ]);
    expect(detectionRows().every((row) => row.detected_at === null)).toBe(true);
  });
});

describe("New titles catalog", () => {
  /** An IMDb List and a Trakt List, both with tt0000001 in their Baseline. */
  async function seedImdbAndTraktLists(traktTitle: string) {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      source_ref: "ur1",
      catalog_title: "IMDb picks",
    });
    seedList(accountId, {
      id: LIST_IDS[1],
      provider: "trakt",
      source_ref: "users/leo/watchlist",
      catalog_title: traktTitle,
    });
    const imdb = sourceList("imdb", [movie("tt0000001")]);
    const trakt = sourceList("trakt", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    await sync(LIST_IDS[1]);
    return { imdb, trakt };
  }

  it("shows each Title once, with its earliest detection, newest first", async () => {
    const { imdb, trakt } = await seedImdbAndTraktLists("2");

    vi.setSystemTime(Date.now() + DAY_MS);
    imdb.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);

    vi.setSystemTime(Date.now() + DAY_MS);
    trakt.metas = [movie("tt0000001"), movie("tt0000002"), movie("tt0000003")];
    await sync(LIST_IDS[1]);

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000003", "tt0000002"]);
    expect(metas[0].description).toBe(
      "Detected by Stremlist on 3 Oct 2026 in your Trakt watchlist.",
    );
    expect(metas[1].description).toBe(
      "Detected by Stremlist on 2 Oct 2026 in IMDb picks.",
    );
    expect((await summary()).summary?.detected).toBe(2);
  });

  it("keeps the earliest date when the List that detected it first drops it", async () => {
    const { imdb, trakt } = await seedImdbAndTraktLists("Trakt picks");

    vi.setSystemTime(Date.now() + DAY_MS);
    imdb.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    trakt.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[1]);
    imdb.metas = [movie("tt0000001")];
    await sync(LIST_IDS[0]);

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000002"]);
    expect(metas[0].description).toBe(
      "Detected by Stremlist on 2 Oct 2026 in IMDb picks.",
    );

    trakt.metas = [movie("tt0000001")];
    await sync(LIST_IDS[1]);
    expect(await newTitles()).toEqual([]);
  });

  it("serves each type in its own catalog and pages with skip", async () => {
    seedImdbList();
    const source = sourceList("imdb", []);
    await sync(LIST_IDS[0]);
    source.metas = [
      movie("tt0000001"),
      series("tt0000002"),
      movie("tt0000003"),
    ];
    await sync(LIST_IDS[0]);

    expect(ids(await newTitles("movie"))).toEqual(["tt0000001", "tt0000003"]);
    expect(ids(await newTitles("series"))).toEqual(["tt0000002"]);
    const res = await app.request(
      `/${accountId}/catalog/movie/new-titles-movie/skip=1.json`,
    );
    expect(ids(((await res.json()) as { metas: StremioMeta[] }).metas)).toEqual(
      ["tt0000003"],
    );
  });

  it("is empty when the Account has not turned it on", async () => {
    seedImdbList(false);
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);

    // History is kept, so turning the catalog on shows it at once.
    expect(detectionRows().some((row) => row.detected_at !== null)).toBe(true);
    expect(await newTitles()).toEqual([]);
  });

  it("never shows Connection lists through a Legacy alias", async () => {
    const legacy = seedLegacyAccount("ur7654321", { new_titles_catalog: true });
    accountId = legacy.id;
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur7654321" });
    seedList(accountId, {
      id: LIST_IDS[1],
      provider: "trakt",
      source_ref: "me/history",
    });
    seedHistory("imdb", "ur7654321", "tt0000001");
    seedHistory("trakt", "me/history", "tt0000002");
    cache.seed(LIST_IDS[0], [movie("tt0000001")]);
    cache.seed(LIST_IDS[1], [movie("tt0000002")]);

    expect(ids(await newTitles("movie", "ur7654321"))).toEqual(["tt0000001"]);
  });

  it("skips a Title until a cached Catalog has its metadata", async () => {
    seedImdbList();
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    cache.reset();

    expect(await newTitles()).toEqual([]);
  });
});

describe("merged Lists", () => {
  const TRAKT_WATCHLIST = {
    provider: "trakt",
    sourceRef: "users/leo/watchlist",
  };

  /**
   * One List that merges the IMDb watchlist `ur1` and a Trakt watchlist,
   * each with its own Baseline: tt0000001 on IMDb, tt0000005 on Trakt.
   */
  async function seedMergedList(catalogTitle = "Merged picks") {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      source_ref: "ur1",
      catalog_title: catalogTitle,
      merged_sources: [
        { provider: "trakt", source_ref: TRAKT_WATCHLIST.sourceRef },
      ],
    });
    const imdb = sourceList("imdb", [movie("tt0000001")]);
    const trakt = sourceList("trakt", [movie("tt0000005")]);
    await sync(LIST_IDS[0]);
    return { imdb, trakt };
  }

  it("count a Title that two of their Source lists add as one new title", async () => {
    const { imdb, trakt } = await seedMergedList();
    expect(await newTitles()).toEqual([]);
    expect(db.getTable("source_list_syncs")).toHaveLength(2);

    vi.setSystemTime(Date.now() + DAY_MS);
    imdb.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    vi.setSystemTime(Date.now() + DAY_MS);
    trakt.metas = [movie("tt0000005"), movie("tt0000002")];
    await sync(LIST_IDS[0]);

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000002"]);
    // The earliest detection, in the List as the user named it.
    expect(metas[0].description).toBe(
      "Detected by Stremlist on 2 Oct 2026 in Merged picks.",
    );
    expect((await summary()).summary).toMatchObject({
      detected: 1,
      waitingLists: 0,
    });
  });

  it("name the Source list that detected the Title when the List has a default title", async () => {
    const { trakt } = await seedMergedList("1");

    vi.setSystemTime(Date.now() + DAY_MS);
    trakt.metas = [movie("tt0000005"), movie("tt0000003")];
    await sync(LIST_IDS[0]);

    const metas = await newTitles();
    expect(ids(metas)).toEqual(["tt0000003"]);
    expect(metas[0].description).toBe(
      "Detected by Stremlist on 2 Oct 2026 in your Trakt watchlist.",
    );
  });

  it("compare their other Source lists while one of them cannot be read", async () => {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      source_ref: "ur1",
      catalog_title: "Merged picks",
      merged_sources: [
        { provider: "trakt", source_ref: TRAKT_WATCHLIST.sourceRef },
      ],
    });
    const imdb = sourceList("imdb", [movie("tt0000001")]);
    const trakt = sourceList("trakt", [movie("tt0000005")]);
    trakt.read = () => {
      throw new SourceUnavailableError("unavailable", "Trakt is down");
    };
    await sync(LIST_IDS[0]);

    // The List waits: one of its Source lists has no Baseline yet.
    expect((await summary()).summary).toMatchObject({ waitingLists: 1 });
    expect(db.getTable("source_list_syncs")).toMatchObject([
      { provider: "imdb", source_ref: "ur1" },
    ]);

    imdb.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);

    // Trakt's first complete read is its Baseline: what it had is not new.
    trakt.read = null;
    trakt.metas = [movie("tt0000005"), movie("tt0000006")];
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    expect((await summary()).summary).toMatchObject({
      detected: 1,
      waitingLists: 0,
    });
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);
  });

  it("do not compare a Source list whose read is cut short", async () => {
    const { imdb, trakt } = await seedMergedList();

    imdb.metas = [movie("tt0000001"), movie("tt0000002")];
    // The first page only: tt0000005 is on a page that was not read.
    trakt.read = () => ({
      entries: [entry(movie("tt0000007"))],
      complete: false,
    });
    await sync(LIST_IDS[0]);

    expect(ids(await newTitles())).toEqual(["tt0000002"]);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);
    expect(detectionRows().some((row) => row.imdb_id === "tt0000007")).toBe(
      false,
    );
  });

  it("start a Baseline for a Source list merged in later", async () => {
    seedImdbList();
    const imdb = sourceList("imdb", [movie("tt0000001")]);
    const trakt = sourceList("trakt", [movie("tt0000005"), movie("tt0000006")]);
    await sync(LIST_IDS[0]);

    db.getTable("lists")[0].merged_sources = [
      { provider: "trakt", source_ref: TRAKT_WATCHLIST.sourceRef },
    ];
    await sync(LIST_IDS[0]);
    expect(await newTitles()).toEqual([]);

    imdb.metas = [movie("tt0000001"), movie("tt0000002")];
    trakt.metas = [movie("tt0000005"), movie("tt0000006"), movie("tt0000003")];
    await sync(LIST_IDS[0]);
    // Read from the cache of each Source list of the merged List.
    expect(ids(await newTitles()).sort()).toEqual(["tt0000002", "tt0000003"]);
  });

  it("are hidden from a Legacy alias when one Source list needs a Connection", async () => {
    const legacy = seedLegacyAccount("ur7654321", { new_titles_catalog: true });
    accountId = legacy.id;
    const merged = {
      id: LIST_IDS[0],
      provider: "imdb" as const,
      sourceRef: "ur7654321",
      mergedSources: [{ provider: "trakt" as const, sourceRef: "me/history" }],
    };
    seedList(accountId, {
      id: merged.id,
      source_ref: merged.sourceRef,
      merged_sources: [{ provider: "trakt", source_ref: "me/history" }],
    });
    seedList(accountId, { id: LIST_IDS[1], source_ref: "ls1", position: 1 });
    seedHistory("imdb", "ur7654321", "tt0000001");
    seedHistory("trakt", "me/history", "tt0000002");
    seedHistory("imdb", "ls1", "tt0000003");
    const [imdbCache, traktCache] = sourceCaches(merged);
    cache.seed(imdbCache.cacheKey, [movie("tt0000001")]);
    cache.seed(traktCache.cacheKey, [movie("tt0000002")]);
    cache.seed(LIST_IDS[1], [movie("tt0000003")]);

    // Not even the Titles of its public Source list: the whole List is hidden.
    expect(ids(await newTitles("movie", "ur7654321"))).toEqual(["tt0000003"]);
  });

  it("are never compared by a Catalog preview", async () => {
    seedNewTitlesAccount();
    sourceList("imdb", [movie("tt0000001")]);
    sourceList("trakt", [movie("tt0000005")]);
    resetPreviewReadings();

    const res = await app.request("/lists/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountKey: accountId,
        provider: "imdb",
        sourceRef: "ur1",
        mergedSources: [TRAKT_WATCHLIST],
        sortOption: "title-asc",
      }),
    });

    expect(res.status).toBe(200);
    expect(db.getTable("source_list_syncs")).toEqual([]);
    expect(detectionRows()).toEqual([]);
  });
});

describe("manifest", () => {
  async function catalogIds(key: string): Promise<string[]> {
    const res = await app.request(`/${key}/manifest.json`);
    return ((await res.json()) as StremioManifest).catalogs.map((c) => c.id);
  }

  it("offers the New titles catalogs first, for the types the Lists show", async () => {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      source_ref: "ur1",
      display_mode: "movie",
    });

    expect(await catalogIds(accountId)).toEqual([
      "new-titles-movie",
      `wl-${LIST_IDS[0]}-movie`,
    ]);
  });

  it("serves the Catalogs that the configure page counts for a reinstall", async () => {
    seedNewTitlesAccount();
    seedList(accountId, {
      id: LIST_IDS[0],
      source_ref: "ur1",
      catalog_title: "Merged",
      display_mode: "series",
      merged_sources: [{ provider: "imdb", source_ref: "ls1" }],
    });
    const res = await app.request(`/${accountId}/manifest.json`);
    const { catalogs } = (await res.json()) as StremioManifest;
    const lists = [
      { id: LIST_IDS[0], catalogTitle: "Merged", displayMode: "series" },
    ] as const;

    expect(catalogs.map(({ name, type }) => ({ name, type }))).toEqual(
      addonCatalogEntries([...lists], { newTitles: true }).map(
        ({ name, type }) => ({ name, type }),
      ),
    );
    expect(catalogs.map((catalog) => catalog.id)).toEqual([
      "new-titles-series",
      `wl-${LIST_IDS[0]}-series`,
    ]);
  });

  it("leaves them out while the setting is off", async () => {
    seedImdbList(false);

    expect(await catalogIds(accountId)).toEqual([
      `wl-${LIST_IDS[0]}-movie`,
      `wl-${LIST_IDS[0]}-series`,
    ]);
  });
});

describe("settings", () => {
  const LIST = {
    provider: "imdb",
    sourceRef: "imdb:top-rated-movies",
    sortOption: "added_at-asc",
  };

  it("saves the setting with the configuration", async () => {
    seedNewTitlesAccount(false);

    const res = await app.request(`/${accountId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST], newTitles: { enabled: true } }),
    });

    expect(res.status).toBe(200);
    expect((await summary()).enabled).toBe(true);
  });

  it("keeps the setting when a save does not send it", async () => {
    seedNewTitlesAccount(true);

    await app.request(`/${accountId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST] }),
    });

    expect((await summary()).enabled).toBe(true);
  });

  it("keeps the setting when a Legacy alias install gets its private copy", async () => {
    const legacy = seedLegacyAccount("ur7654321", { new_titles_catalog: true });
    seedList(legacy.id, { id: LIST_IDS[0], source_ref: "ur7654321" });

    const res = await app.request("/ur7654321/upgrade", { method: "POST" });
    accountId = ((await res.json()) as { accountId: string }).accountId;

    expect(res.status).toBe(200);
    expect((await summary()).enabled).toBe(true);
  });

  it("turns it on for a new Account", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST], newTitles: { enabled: true } }),
    });
    accountId = ((await res.json()) as { accountId: string }).accountId;

    expect((await summary()).enabled).toBe(true);
  });
});

describe("Connection cleanup", () => {
  it("keeps only the current Connection user's history and public Source lists", async () => {
    seedNewTitlesAccount();
    // leo was connected; a refresh already wrote a Baseline for sam.
    seedConnection(accountId, "trakt", { username: "leo" });
    seedHistory("trakt", "me/history", "tt0000001", "leo");
    seedHistory("trakt", "me/collection", "tt0000002", "sam");
    seedHistory("trakt", "users/leo/watchlist", "tt0000003");
    const synced = () =>
      db.getTable("source_list_syncs").map((row) => row.source_ref);

    // sam connects: the history of leo goes in the same transaction.
    await saveConnection(
      accountId,
      "trakt",
      {
        accessToken: "access-1",
        refreshToken: null,
        expiresAt: null,
        scope: null,
      },
      "sam",
      "https://api.stremlist.test/oauth/trakt/callback",
    );
    expect(synced()).toEqual(["me/collection", "users/leo/watchlist"]);

    // After a disconnect, only the public Source list keeps its history.
    await deleteConnection(accountId, "trakt", []);
    expect(db.getTable("connections")).toEqual([]);
    expect(synced()).toEqual(["users/leo/watchlist"]);
    expect(detectionRows().map((row) => row.source_ref)).toEqual([
      "users/leo/watchlist",
    ]);
  });

  it("forgets the previous user's history before a new Connection reads again", async () => {
    seedNewTitlesAccount();
    seedConnection(accountId, "trakt", { username: "leo" });
    seedList(accountId, {
      id: LIST_IDS[0],
      provider: "trakt",
      source_ref: "me/history",
    });
    seedHistory("trakt", "me/history", "tt0000001", "leo");
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [entry(movie("tt0000002"))],
        oauth: {
          authorizeUrl: "https://trakt.example/oauth/authorize",
          tokenUrl: "https://api.trakt.example/oauth/token",
          clientId: () => "client-123",
          scopes: [],
          fetchUsername: () => Promise.resolve("sam"),
        },
      }),
    );
    db.insert("oauth_states", {
      state: "state-abc",
      account_id: accountId,
      provider: "trakt",
      code_verifier: "verifier-xyz",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ access_token: "access-1", expires_in: 7200 }),
        ),
      ),
    );

    const res = await app.request(
      "/oauth/trakt/callback?code=code-1&state=state-abc",
    );

    expect(res.status).toBe(302);
    // The new user's first read is a Baseline, not a list of new titles.
    await vi.waitFor(() => {
      expect(db.getTable("source_list_syncs")).toMatchObject([
        { source_ref: "me/history", connection_user: "sam" },
      ]);
    });
    expect(detectionRows()).toMatchObject([
      { imdb_id: "tt0000002", detected_at: null },
    ]);
    expect(await newTitles()).toEqual([]);
  });
});
