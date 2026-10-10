import { addonCatalogEntries } from "@stremlist/shared/manifest-catalogs";
import type {
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
import { SourceUnavailableError } from "../providers/types";
import { resetPreviewReadings } from "../services/list-preview";
import { sourceCaches } from "../services/merged-lists";
import {
  LIST_IDS,
  movie,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { db } from "./helpers/mock-supabase.js";
import {
  accountId,
  DAY_MS,
  detectionRows,
  entry,
  ids,
  newTitles,
  resetNewTitlesTest,
  restoreNewTitlesTest,
  seedHistory,
  seedImdbList,
  seedNewTitlesAccount,
  series,
  setAccountId,
  sourceList,
  summary,
  sync,
} from "./helpers/new-titles.js";

beforeEach(resetNewTitlesTest);
afterEach(restoreNewTitlesTest);

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
    setAccountId(legacy.id);
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
    setAccountId(legacy.id);
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
