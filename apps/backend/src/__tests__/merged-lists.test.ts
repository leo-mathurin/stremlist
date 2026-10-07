import type { Tables } from "@stremlist/shared/database.types";
import type { ListSource } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/r2", async () => {
  return await import("./helpers/mock-r2.js");
});
vi.mock("../lib/background", () => ({ scheduleBackgroundTask: vi.fn() }));
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import type { SourceEntry } from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
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
import { callRpc, db, resetRpc, supabase } from "./helpers/mock-supabase.js";

const [LIST_1, LIST_2] = LIST_IDS;
const TRAKT_WATCHLIST: ListSource = {
  provider: "trakt",
  sourceRef: "users/sean/watchlist",
};
const JUSTWATCH_LIST: ListSource = {
  provider: "justwatch",
  sourceRef: "tl-us-1",
};
const TRAKT_LIST: ListSource = {
  provider: "trakt",
  sourceRef: "users/sean/lists/picks",
};

let accountId = "";

function entry(
  id: string,
  addedAt?: string,
  type: "movie" | "series" = "movie",
): SourceEntry {
  return {
    imdbId: id,
    type,
    meta: movie(id, { type, name: `Title ${id}` }),
    ...(addedAt ? { addedAt } : {}),
  };
}

/** A fake Provider whose Source lists are keyed by reference. */
function fakeSources(
  provider: ProviderId,
  sources: Partial<Record<string, SourceEntry[] | Error>>,
) {
  useFakeProvider(
    fakeAdapter(provider, {
      fetchSource: (ref) => {
        const value = sources[ref];
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve({ entries: structuredClone(value ?? []) });
      },
    }),
  );
}

function seedMergedList(
  overrides: Partial<Tables<"lists">> & {
    first?: ListSource;
    merged?: ListSource[];
  } = {},
) {
  const { first = TRAKT_WATCHLIST, merged = [TRAKT_LIST], ...rest } = overrides;
  return seedList(accountId, {
    id: LIST_1,
    provider: first.provider,
    source_ref: first.sourceRef,
    merged_sources: merged.map((source) => ({
      provider: source.provider,
      source_ref: source.sourceRef,
    })),
    ...rest,
  });
}

async function catalog(
  key = accountId,
  type = "movie",
  listId: string = LIST_1,
) {
  const res = await app.request(
    `/${key}/catalog/${type}/wl-${listId}-${type}.json`,
  );
  return {
    status: res.status,
    body: (await res.json()) as { metas: StremioMeta[] },
  };
}

function postConfig(lists: unknown[], key = accountId) {
  return app.request(`/${key}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lists }),
  });
}

function listBody(
  first: ListSource,
  mergedSources?: ListSource[],
  overrides: Record<string, unknown> = {},
) {
  return {
    ...first,
    sortOption: "title-asc",
    displayMode: "split",
    ...(mergedSources ? { mergedSources } : {}),
    ...overrides,
  };
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.restoreAllMocks();
  accountId = seedAccount().id;
});

describe("merged Catalog", () => {
  it("shows each Title once and sorts the Source lists together by date added", async () => {
    fakeSources("trakt", {
      [TRAKT_WATCHLIST.sourceRef]: [
        entry("tt1", "2020-01-01T00:00:00Z"),
        entry("tt2", "2024-01-01T00:00:00Z"),
      ],
      [TRAKT_LIST.sourceRef]: [
        entry("tt3", "2022-01-01T00:00:00Z"),
        entry("tt1", "2025-01-01T00:00:00Z"),
      ],
    });
    seedMergedList({ sort_option: "added_at-desc" });

    const { status, body } = await catalog();

    expect(status).toBe(200);
    expect(body.metas.map((meta) => meta.id)).toEqual(["tt2", "tt3", "tt1"]);
    expect(body.metas.some((meta) => "addedAt" in meta)).toBe(false);
  });

  it("caches each Source list on its own key", async () => {
    fakeSources("trakt", {
      [TRAKT_WATCHLIST.sourceRef]: [entry("tt1")],
      [TRAKT_LIST.sourceRef]: [entry("tt2")],
    });
    const row = seedMergedList();

    await catalog();

    const keys = sourceCaches({
      id: row.id,
      ...TRAKT_WATCHLIST,
      mergedSources: [TRAKT_LIST],
    });
    expect(cache.get(keys[0].cacheKey)?.data.metas.map((m) => m.id)).toEqual([
      "tt1",
    ]);
    expect(cache.get(keys[1].cacheKey)?.data.metas.map((m) => m.id)).toEqual([
      "tt2",
    ]);
    expect(cache.get(row.id)).toBeNull();
  });

  it("follows the List's order when a Source list has no dates", async () => {
    fakeSources("trakt", {
      [TRAKT_WATCHLIST.sourceRef]: [
        entry("tt1", "2025-01-01T00:00:00Z"),
        entry("tt2", "2026-01-01T00:00:00Z"),
      ],
    });
    fakeSources("justwatch", {
      [JUSTWATCH_LIST.sourceRef]: [entry("tt3"), entry("tt2"), entry("tt0")],
    });
    // Equal (missing) ratings keep the canonical order.
    seedMergedList({ merged: [JUSTWATCH_LIST], sort_option: "rating-desc" });

    const { body } = await catalog();

    expect(body.metas.map((meta) => meta.id)).toEqual([
      "tt1",
      "tt2",
      "tt3",
      "tt0",
    ]);
  });

  it("still shows the other Source lists when one cannot be read", async () => {
    fakeSources("trakt", {
      [TRAKT_WATCHLIST.sourceRef]: new SourceUnavailableError(
        "private",
        "private",
      ),
      [TRAKT_LIST.sourceRef]: [entry("tt2")],
    });
    seedMergedList();

    const { status, body } = await catalog();

    expect(status).toBe(200);
    expect(body.metas.map((meta) => meta.id)).toEqual(["tt2"]);
  });

  it("explains the first problem when no Source list can be read", async () => {
    fakeSources("trakt", {
      [TRAKT_WATCHLIST.sourceRef]: new SourceUnavailableError(
        "private",
        "private",
      ),
      [TRAKT_LIST.sourceRef]: new SourceUnavailableError("not_found", "gone"),
    });
    seedMergedList();

    const { status, body } = await catalog();

    expect(status).toBe(200);
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].id).toBe("stremlist:unavailable:private");
    expect(body.metas[0].name).toContain("This Trakt watchlist is private");
  });

  it("never answers a merged List with a Connection Source list through a Legacy alias", async () => {
    accountId = seedLegacyAccount("ur12345678").id;
    fakeSources("trakt", { [TRAKT_WATCHLIST.sourceRef]: [entry("tt1")] });
    seedMergedList({
      merged: [{ provider: "trakt", sourceRef: "me/history" }],
    });

    const { body } = await catalog("ur12345678");
    expect(body.metas).toEqual([]);

    const manifest = await app.request("/ur12345678/manifest.json");
    const json = (await manifest.json()) as { catalogs: unknown[] };
    expect(json.catalogs).toEqual([]);
  });

  it("finds a Title of a merged List for the meta route, from the cache only", async () => {
    const row = seedMergedList();
    const [, second] = sourceCaches({
      id: row.id,
      ...TRAKT_WATCHLIST,
      mergedSources: [TRAKT_LIST],
    });
    cache.seed(second.cacheKey, [
      { ...movie("tt9"), addedAt: "2020-01-01T00:00:00.000Z" } as StremioMeta,
    ]);

    const res = await app.request(`/${accountId}/meta/movie/tt9.json`);
    const json = (await res.json()) as { meta: StremioMeta | null };

    expect(json.meta?.id).toBe("tt9");
    expect(json.meta && "addedAt" in json.meta).toBe(false);
  });

  it("keeps the Simkl link back of every cached copy on the detail page", async () => {
    const row = seedMergedList({
      merged: [{ provider: "simkl", sourceRef: "me/plantowatch" }],
    });
    seedConnection(accountId, "simkl");
    const [first, simkl] = sourceCaches({
      id: row.id,
      ...TRAKT_WATCHLIST,
      mergedSources: [{ provider: "simkl", sourceRef: "me/plantowatch" }],
    });
    cache.seed(first.cacheKey, [movie("tt9", { description: "A plot." })]);
    cache.seed(simkl.cacheKey, [
      movie("tt9", {
        description: "A plot.\n\nMore on Simkl: https://simkl.com/movies/9/x",
      }),
    ]);

    const res = await app.request(`/${accountId}/meta/movie/tt9.json`);
    const json = (await res.json()) as { meta: StremioMeta | null };

    expect(json.meta?.description).toBe(
      "A plot.\n\nMore on Simkl: https://simkl.com/movies/9/x",
    );
  });

  it("counts a merged List as failed on refresh when one Source list fails", async () => {
    db.getTable("accounts")[0].last_fetched_at = new Date(0).toISOString();
    fakeSources("trakt", {
      [TRAKT_WATCHLIST.sourceRef]: [entry("tt1")],
      [TRAKT_LIST.sourceRef]: new SourceUnavailableError("unavailable", "503"),
    });
    seedMergedList();

    const res = await app.request(`/${accountId}/refresh`, { method: "POST" });
    const json = (await res.json()) as { refreshed: number; failed: number };

    expect(json).toMatchObject({ refreshed: 0, failed: 1 });
  });

  it("drops the cache of a Connection Source list on disconnect", async () => {
    seedConnection(accountId, "trakt");
    const row = seedMergedList({
      merged: [{ provider: "trakt", sourceRef: "me/history" }],
    });
    const [publicKey, privateKey] = sourceCaches({
      id: row.id,
      ...TRAKT_WATCHLIST,
      mergedSources: [{ provider: "trakt", sourceRef: "me/history" }],
    });
    cache.seed(publicKey.cacheKey, [movie("tt1")]);
    cache.seed(privateKey.cacheKey, [movie("tt2")]);

    await app.request(`/${accountId}/connections/trakt`, { method: "DELETE" });

    expect(cache.get(publicKey.cacheKey)).not.toBeNull();
    expect(cache.get(privateKey.cacheKey)).toBeNull();
  });
});

describe("saving merged Lists", () => {
  it("saves the merged Source lists and returns them", async () => {
    const res = await postConfig([
      listBody(TRAKT_WATCHLIST, [
        TRAKT_LIST,
        { ...JUSTWATCH_LIST, label: "Family picks" },
      ]),
    ]);
    expect(res.status).toBe(200);

    const config = await app.request(`/${accountId}/config`);
    const json = (await config.json()) as {
      lists: { mergedSources?: ListSource[] }[];
    };
    // The label names a Source list on the configure page only.
    expect(json.lists[0].mergedSources).toEqual([
      TRAKT_LIST,
      { ...JUSTWATCH_LIST, label: "Family picks" },
    ]);
    expect(db.getTable("lists")[0].merged_sources).toEqual([
      { provider: "trakt", source_ref: TRAKT_LIST.sourceRef },
      {
        provider: "justwatch",
        source_ref: JUSTWATCH_LIST.sourceRef,
        label: "Family picks",
      },
    ]);
  });

  it("keeps the saved merged Source lists when a client omits them", async () => {
    seedMergedList();

    const res = await postConfig([
      { ...listBody(TRAKT_WATCHLIST), id: LIST_1, sortOption: "year-desc" },
    ]);

    expect(res.status).toBe(200);
    const [row] = db.getTable("lists");
    expect(row.sort_option).toBe("year-desc");
    expect(row.merged_sources).toEqual([
      { provider: "trakt", source_ref: TRAKT_LIST.sourceRef },
    ]);
  });

  it("refuses a save that keeps merged Source lists another save changed", async () => {
    seedMergedList();
    const concurrent = [
      { provider: "trakt", source_ref: TRAKT_LIST.sourceRef },
      { provider: "justwatch", source_ref: JUSTWATCH_LIST.sourceRef },
    ];
    // Another save merges a Source list after this save read the Lists and
    // before its transaction runs.
    const rpc = vi.spyOn(supabase, "rpc");
    rpc.mockImplementationOnce((name, args) => {
      db.getTable("lists")[0].merged_sources = concurrent;
      return callRpc(name, args);
    });

    const res = await postConfig([
      { ...listBody(TRAKT_WATCHLIST), id: LIST_1, sortOption: "year-desc" },
    ]);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Your Lists changed in another window. Reload the page and try again.",
    );
    const [row] = db.getTable("lists");
    expect(row.merged_sources).toEqual(concurrent);
    expect(row.sort_option).toBe("added_at-asc");
  });

  it("keeps the label of a merged Source list that moved to the first place", async () => {
    const res = await postConfig([
      listBody({ ...JUSTWATCH_LIST, label: "Family picks" }, [TRAKT_LIST], {
        sourceLabel: "Family picks",
      }),
    ]);
    expect(res.status).toBe(200);
    expect(db.getTable("lists")[0].source_label).toBe("Family picks");

    const config = await app.request(`/${accountId}/config`);
    const json = (await config.json()) as {
      lists: { sourceLabel?: string }[];
    };
    expect(json.lists[0].sourceLabel).toBe("Family picks");

    // A client that omits the label keeps it while the first Source list
    // stays the same.
    const listId = db.getTable("lists")[0].id as string;
    const kept = await postConfig([
      { ...listBody(JUSTWATCH_LIST, [TRAKT_LIST]), id: listId },
    ]);
    expect(kept.status).toBe(200);
    expect(db.getTable("lists")[0].source_label).toBe("Family picks");
    const changed = await postConfig([
      { ...listBody(TRAKT_LIST, [JUSTWATCH_LIST]), id: listId },
    ]);
    expect(changed.status).toBe(200);
    expect(db.getTable("lists")[0].source_label).toBeNull();
  });

  it("deletes the caches that splitting a merged List leaves unused", async () => {
    const row = seedMergedList();
    const keys = sourceCaches({
      id: row.id,
      ...TRAKT_WATCHLIST,
      mergedSources: [TRAKT_LIST],
    });
    for (const { cacheKey } of keys) cache.seed(cacheKey, [movie("tt1")]);

    const res = await postConfig([
      { ...listBody(TRAKT_WATCHLIST, []), id: LIST_1 },
      listBody(TRAKT_LIST),
    ]);

    expect(res.status).toBe(200);
    expect(keys.map(({ cacheKey }) => cache.get(cacheKey))).toEqual([
      null,
      null,
    ]);
  });

  it.each([
    {
      name: "a Source list in two Lists",
      lists: [listBody(TRAKT_WATCHLIST, [TRAKT_LIST]), listBody(TRAKT_LIST)],
      error: "Each list can only be added once.",
    },
    {
      name: "too many Source lists in one List",
      lists: [
        listBody(
          TRAKT_WATCHLIST,
          Array.from({ length: 5 }, (_, i) => ({
            provider: "trakt",
            sourceRef: `users/sean/lists/l${i}`,
          })),
        ),
      ],
      error: "A List can merge at most 5 Source lists.",
    },
    {
      name: "a display mode without a single-type Source list",
      lists: [
        listBody(
          TRAKT_WATCHLIST,
          [{ provider: "imdb", sourceRef: "imdb:top-rated-tv" }],
          { displayMode: "movie" },
        ),
      ],
      error:
        "Top 250 TV Shows has only TV shows, so this List cannot show only movies.",
    },
    {
      name: "a date sort with a Source list without dates",
      lists: [
        listBody(TRAKT_WATCHLIST, [JUSTWATCH_LIST], {
          sortOption: "added_at-desc",
        }),
      ],
      error:
        "The JustWatch list does not give the date when each Title was added, so this List cannot sort by date added.",
    },
    {
      name: "a Connection Source list without a Connection",
      lists: [
        listBody(TRAKT_WATCHLIST, [
          { provider: "trakt", sourceRef: "me/history" },
        ]),
      ],
      error: "Connect your Trakt account first.",
    },
    {
      name: "a Provider that is not available yet",
      lists: [
        listBody(TRAKT_WATCHLIST, [
          { provider: "letterboxd", sourceRef: "users/leo/watchlist" },
        ]),
      ],
      error: "Letterboxd is not available yet.",
    },
    {
      name: "more than 20 Source lists in the Account",
      lists: Array.from({ length: 5 }, (_, list) =>
        listBody(
          { provider: "trakt", sourceRef: `users/u${list}/watchlist` },
          Array.from({ length: 4 }, (_, i) => ({
            provider: "trakt",
            sourceRef: `users/u${list}/lists/l${i}`,
          })),
        ),
      ),
      error: "You can have at most 20 Source lists in all your Lists.",
    },
  ])("refuses $name", async ({ lists, error }) => {
    const res = await postConfig(lists);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    expect(db.getTable("lists")).toEqual([]);
  });

  it("accepts a Connection Source list once the Provider is connected", async () => {
    seedConnection(accountId, "trakt");

    const res = await postConfig([
      listBody(
        TRAKT_WATCHLIST,
        [{ provider: "trakt", sourceRef: "me/history" }],
        {
          sortOption: "added_at-desc",
        },
      ),
    ]);

    expect(res.status).toBe(200);
  });

  it("refuses a Connection Source list through a Legacy alias", async () => {
    accountId = seedLegacyAccount("ur12345678").id;

    const res = await postConfig(
      [
        listBody(TRAKT_WATCHLIST, [
          { provider: "trakt", sourceRef: "me/history" },
        ]),
      ],
      "ur12345678",
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Trakt lists need your private Addon URL. Upgrade this install first.",
    );
  });

  it("copies merged Source lists into a private copy", async () => {
    accountId = seedLegacyAccount("ur12345678").id;
    seedMergedList();
    seedList(accountId, {
      id: LIST_2,
      provider: "justwatch",
      source_ref: JUSTWATCH_LIST.sourceRef,
      position: 1,
    });

    const res = await app.request("/ur12345678/upgrade", { method: "POST" });
    const { accountId: copyId } = (await res.json()) as { accountId: string };

    const copy = db
      .getTable("lists")
      .filter((row) => row.account_id === copyId);
    expect(copy.map((row) => row.merged_sources)).toEqual([
      [{ provider: "trakt", source_ref: TRAKT_LIST.sourceRef }],
      [],
    ]);
  });
});
