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
import type { SourceEntry } from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
import { entryKey } from "../services/detections";
import {
  LIST_IDS,
  movie,
  seedConnection,
  seedList,
} from "./helpers/fixtures.js";
import { fakeAdapter, useFakeProvider } from "./helpers/mock-registry.js";
import { db } from "./helpers/mock-supabase.js";
import {
  accountId,
  DAY_MS,
  detectionRows,
  entry,
  ids,
  NEXT_SYNC_MS,
  newTitles,
  resetNewTitlesTest,
  restoreNewTitlesTest,
  seedImdbList,
  seedNewTitlesAccount,
  sourceList,
  summary,
  sync,
} from "./helpers/new-titles.js";

beforeEach(resetNewTitlesTest);
afterEach(restoreNewTitlesTest);

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
