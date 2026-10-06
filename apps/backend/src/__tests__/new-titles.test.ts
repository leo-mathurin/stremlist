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
import { forgetConnectionDetections } from "../services/detections";
import {
  LIST_IDS,
  movie,
  seedAccount,
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

/** Stremio asks for a List catalog after its cache went stale. */
async function sync(listId: string, type: "movie" | "series" = "movie") {
  vi.setSystemTime(Date.now() + NEXT_SYNC_MS);
  const res = await app.request(
    `/${accountId}/catalog/${type}/wl-${listId}-${type}.json`,
  );
  expect(res.status).toBe(200);
}

async function newTitles(
  type: "movie" | "series" = "movie",
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
  return db.getTable("title_detections");
}

async function summary() {
  const res = await app.request(`/${accountId}/config`);
  expect(res.status).toBe(200);
  return ((await res.json()) as AccountConfigResponse).newTitles;
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
});

describe("detection", () => {
  it("uses the first complete synchronization as the Baseline", async () => {
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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
  });

  it("does not compare a read cut by a page cap", async () => {
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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

  it("does not compare a read with an Unresolved entry", async () => {
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
    const unresolved: SourceEntry = { title: "Not on IMDb yet", type: "movie" };
    const source = sourceList("imdb", []);
    source.read = () => ({
      entries: [entry(movie("tt0000001")), unresolved],
    });

    // No Baseline while an entry is unresolved.
    await sync(LIST_IDS[0]);
    expect(db.getTable("source_list_syncs")).toEqual([]);
    expect((await summary()).summary?.waitingLists).toBe(1);

    // The entry resolves: the Baseline has it, so it is not "new".
    source.read = null;
    source.metas = [movie("tt0000001"), movie("tt0000009")];
    await sync(LIST_IDS[0]);
    expect(await newTitles()).toEqual([]);

    // A new Title next to an Unresolved entry waits for a complete read.
    source.read = () => ({
      entries: [
        entry(movie("tt0000001")),
        entry(movie("tt0000009")),
        entry(movie("tt0000010")),
        unresolved,
      ],
    });
    await sync(LIST_IDS[0]);
    expect(await newTitles()).toEqual([]);
    expect(detectionRows().every((row) => row.removed_at === null)).toBe(true);

    source.read = null;
    source.metas = [movie("tt0000001"), movie("tt0000009"), movie("tt0000010")];
    await sync(LIST_IDS[0]);
    expect(ids(await newTitles())).toEqual(["tt0000010"]);
  });

  it("keeps the first detection of a Title that is removed and added again", async () => {
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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

describe("New titles catalog", () => {
  it("shows each Title once, with its earliest detection, newest first", async () => {
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
      catalog_title: "2",
    });
    const imdb = sourceList("imdb", [movie("tt0000001")]);
    const trakt = sourceList("trakt", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    await sync(LIST_IDS[1]);

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

  it("serves each type in its own catalog and pages with skip", async () => {
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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
    seedNewTitlesAccount(false);
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
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
    const at = new Date().toISOString();
    for (const [provider, sourceRef, imdbId] of [
      ["imdb", "ur7654321", "tt0000001"],
      ["trakt", "me/history", "tt0000002"],
    ]) {
      db.insert("source_list_syncs", {
        account_id: accountId,
        provider,
        source_ref: sourceRef,
        baseline_at: at,
        last_complete_sync_at: at,
      });
      db.insert("title_detections", {
        account_id: accountId,
        provider,
        source_ref: sourceRef,
        imdb_id: imdbId,
        detected_at: at,
      });
    }
    cache.seed(LIST_IDS[0], [movie("tt0000001")]);
    cache.seed(LIST_IDS[1], [movie("tt0000002")]);

    expect(ids(await newTitles("movie", "ur7654321"))).toEqual(["tt0000001"]);
  });

  it("skips a Title until a cached Catalog has its metadata", async () => {
    seedNewTitlesAccount();
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
    const source = sourceList("imdb", [movie("tt0000001")]);
    await sync(LIST_IDS[0]);
    source.metas = [movie("tt0000001"), movie("tt0000002")];
    await sync(LIST_IDS[0]);
    cache.reset();

    expect(await newTitles()).toEqual([]);
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

  it("leaves them out while the setting is off", async () => {
    seedNewTitlesAccount(false);
    seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });

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

describe("disconnect", () => {
  it("forgets the history of Source lists that only the Connection reads", async () => {
    seedNewTitlesAccount();
    const at = new Date().toISOString();
    for (const sourceRef of ["me/history", "users/leo/watchlist"]) {
      db.insert("source_list_syncs", {
        account_id: accountId,
        provider: "trakt",
        source_ref: sourceRef,
        baseline_at: at,
        last_complete_sync_at: at,
      });
      db.insert("title_detections", {
        account_id: accountId,
        provider: "trakt",
        source_ref: sourceRef,
        imdb_id: "tt0000001",
        detected_at: at,
      });
    }

    await forgetConnectionDetections(accountId, "trakt");

    expect(
      db.getTable("source_list_syncs").map((row) => row.source_ref),
    ).toEqual(["users/leo/watchlist"]);
    expect(detectionRows().map((row) => row.source_ref)).toEqual([
      "users/leo/watchlist",
    ]);
  });
});
