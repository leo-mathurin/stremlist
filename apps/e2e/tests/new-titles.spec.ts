import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  AccountConfigResponse,
  ConfigListInput,
  NewTitlesSummary,
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import {
  CONNECTION_ENCRYPTION_KEY,
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  REFRESH_COOLDOWN_SECONDS,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../env.js";
import { asInput, getCatalog, getManifest, getMeta } from "../helpers/api.js";
import { CATALOG_TITLES, seedCatalog } from "../helpers/catalog-fixture.js";
import { SAVED_REINSTALL, saveButton } from "../helpers/configure.js";
import {
  clearRefreshCooldown,
  db,
  resetDb,
  seedAccount,
  seedAccountWithLists,
  seedConnection,
  seedDetectionHistory,
  seedList,
} from "../helpers/db.js";
import type { ProviderBackend } from "../helpers/provider-backend.js";
import { startProviderBackend } from "../helpers/provider-backend.js";
import { seedCachedCatalog } from "../helpers/r2.js";
import type { SourceFixture } from "../helpers/source-transport.js";
import { CATALOG_FIXTURE_USER } from "../helpers/test-data.js";

// New titles (ADR 0007): consecutive refreshes of Source lists that the test
// controls. The real backend, ID resolver, database and R2 store run in an
// isolated process; only the Provider transport is the fixture.

const WATCHLIST = "ur9999999999201";
const TRAKT_USER = "e2e-fixture";
const TRAKT_REF = `users/${TRAKT_USER}/watchlist`;
const A = "tt9910001";
const B = "tt9910002";
const C = "tt9910003";
const D = "tt9910004";
const E = "tt9910005";
const TITLES: SourceFixture["titles"] = {
  [A]: { name: "QA Detection Alpha", year: 2001, type: "movie" },
  [B]: { name: "QA Detection Bravo", year: 2002, type: "movie" },
  [C]: { name: "QA Detection Charlie", year: 2003, type: "movie" },
  [D]: { name: "QA Detection Delta", year: 2004, type: "movie" },
  [E]: { name: "QA Detection Echo", year: 2005, type: "series" },
};
const NEVER_RESOLVED = { trakt: 99_009, name: "QA Never On IMDb", year: 2020 };

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function sources(
  imdb: string[],
  trakt: SourceFixture["trakt"][string]["items"] = [],
  read: { imdbFails?: boolean; imdbCapped?: boolean } = {},
  watchlist = WATCHLIST,
): SourceFixture {
  return {
    imdb: {
      [watchlist]: {
        ids: imdb,
        fail: read.imdbFails,
        capped: read.imdbCapped,
      },
    },
    trakt: { [TRAKT_USER]: { items: trakt } },
    titles: TITLES,
  };
}

function traktItem(trakt: number, imdb: string) {
  return { trakt, imdb, name: TITLES[imdb].name, year: TITLES[imdb].year };
}

let backend: ProviderBackend;
let fixtureDir: string;
let fixtureFile: string;

/** Rewrite the Source lists that the isolated backend reads next. */
function writeSources(state: SourceFixture) {
  writeFileSync(fixtureFile, JSON.stringify(state));
}

test.beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "stremlist-sources-"));
  fixtureFile = join(fixtureDir, "sources.json");
  writeSources(sources([]));
  backend = await startProviderBackend("./source-transport.ts", {
    E2E_SOURCE_FIXTURE_FILE: fixtureFile,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FRONTEND_URL,
    REFRESH_COOLDOWN_SECONDS: String(REFRESH_COOLDOWN_SECONDS),
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    CONNECTION_ENCRYPTION_KEY,
    // Public Trakt reads need a client ID header; the fixture ignores it.
    TRAKT_CLIENT_ID: "fixture-only",
    RESEND_API_KEY: "re_e2e_dummy_key",
  });
});
test.afterAll(async () => {
  await backend?.stop();
  rmSync(fixtureDir, { recursive: true, force: true });
});
test.beforeEach(async () => {
  await resetDb();
});

/** An Account with the New titles catalog on and these Lists. */
function seedDetectionAccount(
  lists: {
    provider: "imdb" | "trakt";
    sourceRef: string;
    title: string;
    displayMode?: "movie" | "split";
  }[],
) {
  return seedAccountWithLists(
    lists.map((list) => ({
      provider: list.provider,
      sourceRef: list.sourceRef,
      catalogTitle: list.title,
      displayMode: list.displayMode ?? "movie",
    })),
    { newTitlesCatalog: true },
  );
}

/** One synchronization of every List, as the Refresh button asks. */
async function refreshAll(accountId: string, state: SourceFixture) {
  writeSources(state);
  await clearRefreshCooldown(accountId);
  const response = await fetch(`${backend.url}/${accountId}/refresh`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    refreshed: number;
    failed: number;
    newTitles: NewTitlesSummary | null;
  };
}

async function newTitles(
  accountId: string,
  type: "movie" | "series" = "movie",
  extra = "",
): Promise<StremioMeta[]> {
  const response = await fetch(
    `${backend.url}/${accountId}/catalog/${type}/new-titles-${type}${extra}.json`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { metas: StremioMeta[] }).metas;
}

const ids = (metas: StremioMeta[]) => metas.map((meta) => meta.id);

async function readConfig(accountKey: string): Promise<AccountConfigResponse> {
  const response = await fetch(`${backend.url}/${accountKey}/config`);
  expect(response.status).toBe(200);
  return (await response.json()) as AccountConfigResponse;
}

/** Save these Lists through the isolated backend, as the configure page does. */
async function saveLists(accountId: string, lists: ConfigListInput[]) {
  const response = await fetch(`${backend.url}/${accountId}/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lists }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { newTitles: NewTitlesSummary | null };
}

async function syncRows(accountId: string) {
  const { data, error } = await db
    .from("source_list_syncs")
    .select("provider, source_ref, baseline_at")
    .eq("account_id", accountId)
    .order("provider");
  if (error) throw error;
  return data;
}

async function entryRows(accountId: string) {
  const { data, error } = await db
    .from("source_list_entries")
    .select("*")
    .eq("account_id", accountId)
    .order("entry_key");
  if (error) throw error;
  return data;
}

const detected = (list: string) =>
  `Detected by Stremlist on ${DATE.format(new Date())} in ${list}.`;

test(
  "the first refresh is the Baseline; later additions show once, newest first",
  { tag: "@local" },
  async () => {
    const { accountId } = await seedDetectionAccount([
      { provider: "imdb", sourceRef: WATCHLIST, title: "QA watchlist" },
      { provider: "trakt", sourceRef: TRAKT_REF, title: "QA Trakt picks" },
    ]);

    const baseline = await refreshAll(
      accountId,
      sources([A, B], [traktItem(1, A)]),
    );
    expect(baseline).toMatchObject({ refreshed: 2, failed: 0 });
    expect(baseline.newTitles).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 0,
    });
    expect(await newTitles(accountId)).toEqual([]);

    await refreshAll(accountId, sources([A, B, C], [traktItem(1, A)]));
    expect((await newTitles(accountId)).map((meta) => meta.id)).toEqual([C]);

    // C also reaches the Trakt watchlist later: it keeps its first detection.
    const last = await refreshAll(
      accountId,
      sources([A, B, C], [traktItem(1, A), traktItem(3, C), traktItem(4, D)]),
    );
    const metas = await newTitles(accountId);
    expect(metas.map((meta) => [meta.id, meta.name])).toEqual([
      [D, "QA Detection Delta"],
      [C, "QA Detection Charlie"],
    ]);
    expect(metas[0].description).toMatch(
      new RegExp(`^${detected("QA Trakt picks")}`),
    );
    expect(metas[1].description).toMatch(
      new RegExp(`^${detected("QA watchlist")}`),
    );
    expect(last.newTitles).toMatchObject({ detected: 2, waitingLists: 0 });

    const manifest = (await (
      await fetch(`${backend.url}/${accountId}/manifest.json`)
    ).json()) as StremioManifest;
    expect(manifest.catalogs[0]).toMatchObject({
      id: "new-titles-movie",
      name: "Stremlist New titles",
      type: "movie",
    });
    expect(manifest.catalogs.map((catalog) => catalog.id)).not.toContain(
      "new-titles-series",
    );
  },
);

test(
  "a failed refresh between two complete ones creates no removal and no new title",
  { tag: "@local" },
  async () => {
    const { accountId } = await seedDetectionAccount([
      { provider: "imdb", sourceRef: WATCHLIST, title: "QA watchlist" },
    ]);
    await refreshAll(accountId, sources([A, B]));
    await refreshAll(accountId, sources([A, B, C]));
    expect((await newTitles(accountId)).map((meta) => meta.id)).toEqual([C]);
    const before = await entryRows(accountId);

    const failed = await refreshAll(
      accountId,
      sources([], [], { imdbFails: true }),
    );
    expect(failed).toMatchObject({ refreshed: 0, failed: 1 });
    expect(await entryRows(accountId)).toEqual(before);
    expect((await newTitles(accountId)).map((meta) => meta.id)).toEqual([C]);

    await refreshAll(accountId, sources([A, B, C]));
    expect(await entryRows(accountId)).toEqual(before);
    expect(before.every((row) => row.removed_at === null)).toBe(true);
    expect((await newTitles(accountId)).map((meta) => meta.id)).toEqual([C]);
  },
);

test(
  "an Unresolved entry does not block the Baseline or the detection of others",
  { tag: "@local" },
  async () => {
    const { accountId } = await seedDetectionAccount([
      { provider: "trakt", sourceRef: TRAKT_REF, title: "QA Trakt picks" },
    ]);

    const baseline = await refreshAll(
      accountId,
      sources([], [traktItem(1, A), NEVER_RESOLVED]),
    );
    expect(baseline).toMatchObject({ refreshed: 1, failed: 0 });
    expect(baseline.newTitles?.waitingLists).toBe(0);

    await refreshAll(
      accountId,
      sources([], [traktItem(1, A), NEVER_RESOLVED, traktItem(2, B)]),
    );
    const metas = await newTitles(accountId);
    expect(metas.map((meta) => meta.id)).toEqual([B]);
    expect(metas[0].description).toMatch(
      new RegExp(`^${detected("QA Trakt picks")}`),
    );
    expect(
      (await entryRows(accountId)).map((row) => [
        row.entry_key,
        row.imdb_id,
        row.detected_at === null,
        row.removed_at,
      ]),
    ).toEqual([
      ["trakt-movie:1", A, true, null],
      ["trakt-movie:2", B, false, null],
      ["trakt-movie:99009", null, true, null],
    ]);
  },
);

test(
  "a read cut short by the page cap is served but never compared",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedDetectionAccount([
      { provider: "imdb", sourceRef: WATCHLIST, title: "QA watchlist" },
    ]);

    const capped = await refreshAll(
      accountId,
      sources([A, B], [], { imdbCapped: true }),
    );
    expect(capped).toMatchObject({ refreshed: 1, failed: 0 });
    expect(capped.newTitles).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 1,
    });
    expect(await syncRows(accountId)).toEqual([]);
    // The cut-short read still serves the List's own Catalog.
    const manifest = (await (
      await fetch(`${backend.url}/${accountId}/manifest.json`)
    ).json()) as StremioManifest;
    const listCatalog = manifest.catalogs.find(
      (catalog) => !catalog.id.startsWith("new-titles-"),
    );
    const served = await fetch(
      `${backend.url}/${accountId}/catalog/movie/${listCatalog?.id}.json`,
    );
    expect(
      ids(((await served.json()) as { metas: StremioMeta[] }).metas).sort(),
    ).toEqual([A, B]);

    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);
    await expect(
      page.getByText(
        "No new titles detected yet. Stremlist could not read 1 List in full yet, so it cannot compare it.",
      ),
    ).toBeVisible();

    // The first complete read is the Baseline, also for C, which the
    // cut-short read did not have.
    const baseline = await refreshAll(accountId, sources([A, B, C]));
    expect(baseline.newTitles).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 0,
    });
    expect(await newTitles(accountId)).toEqual([]);
    const known = await entryRows(accountId);
    expect(
      known.map((row) => [row.entry_key, row.detected_at, row.removed_at]),
    ).toEqual([
      [`imdb:${A}`, null, null],
      [`imdb:${B}`, null, null],
      [`imdb:${C}`, null, null],
    ]);

    // A later cut-short read without B and C removes nothing.
    await refreshAll(accountId, sources([A], [], { imdbCapped: true }));
    expect(await entryRows(accountId)).toEqual(known);

    await refreshAll(accountId, sources([A, B, C, D]));
    expect(ids(await newTitles(accountId))).toEqual([D]);
    await page.reload();
    await expect(
      page.getByText(/^1 new title detected, the latest .+\.$/),
    ).toBeVisible();
  },
);

test(
  "a Title that leaves and comes back keeps its first detection, also when its List is removed and added again",
  { tag: "@local" },
  async () => {
    const { accountId } = await seedDetectionAccount([
      { provider: "imdb", sourceRef: WATCHLIST, title: "QA watchlist" },
      { provider: "trakt", sourceRef: TRAKT_REF, title: "QA Trakt picks" },
    ]);
    const trakt = [traktItem(1, A)];
    const entryOf = async (imdbId: string) =>
      (await entryRows(accountId)).find(
        (row) => row.entry_key === `imdb:${imdbId}`,
      );

    await refreshAll(accountId, sources([A, B], trakt));
    await refreshAll(accountId, sources([A, B, C], trakt));
    const first = await entryOf(C);
    expect(first?.detected_at).toBeTruthy();
    const detectedAt = new Date(first!.detected_at!).toISOString();

    const gone = await refreshAll(accountId, sources([A, B], trakt));
    expect(gone.newTitles).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 0,
    });
    expect(await newTitles(accountId)).toEqual([]);
    expect((await entryOf(C))?.removed_at).toBeTruthy();

    const back = await refreshAll(accountId, sources([A, B, C], trakt));
    expect(back.newTitles).toEqual({
      detected: 1,
      latestDetectedAt: detectedAt,
      waitingLists: 0,
    });
    expect(ids(await newTitles(accountId))).toEqual([C]);
    expect(await entryOf(C)).toMatchObject({
      detected_at: first!.detected_at,
      removed_at: null,
    });

    // Removing the List hides its Titles but keeps its history.
    const [watchlistList, traktList] = (await readConfig(accountId)).lists;
    const history = await syncRows(accountId);
    const removed = await saveLists(accountId, asInput([traktList]));
    expect(removed.newTitles).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 0,
    });
    expect(await newTitles(accountId)).toEqual([]);
    expect(await syncRows(accountId)).toEqual(history);

    // Added again as a new List, it keeps its Baseline: nothing in it
    // becomes new, and C keeps its first detection.
    const [readded] = asInput([watchlistList]);
    const added = await saveLists(accountId, [
      ...asInput([traktList]),
      { ...readded, id: undefined },
    ]);
    expect(added.newTitles).toEqual({
      detected: 1,
      latestDetectedAt: detectedAt,
      waitingLists: 0,
    });
    await refreshAll(accountId, sources([A, B, C], trakt));
    expect(await syncRows(accountId)).toEqual(history);
    const metas = await newTitles(accountId);
    expect(ids(metas)).toEqual([C]);
    expect(metas[0].description).toMatch(
      new RegExp(`^${detected("QA watchlist")}`),
    );
    // Stremio opens the Title through the meta route.
    const { status, meta } = await getMeta(accountId, "movie", C);
    expect(status).toBe(200);
    expect(meta).toMatchObject({ id: C, name: "QA Detection Charlie" });
  },
);

test(
  "series have their own New titles catalog, without search and paged with skip",
  { tag: "@local" },
  async () => {
    const { accountId } = await seedDetectionAccount([
      {
        provider: "imdb",
        sourceRef: WATCHLIST,
        title: "QA watchlist",
        displayMode: "split",
      },
    ]);
    await refreshAll(accountId, sources([A]));
    await refreshAll(accountId, sources([A, E, C]));

    const manifest = (await (
      await fetch(`${backend.url}/${accountId}/manifest.json`)
    ).json()) as StremioManifest;
    expect(manifest.catalogs.slice(0, 2)).toEqual([
      {
        id: "new-titles-movie",
        name: "Stremlist New titles",
        type: "movie",
        extra: [{ name: "skip", isRequired: false }],
      },
      {
        id: "new-titles-series",
        name: "Stremlist New titles",
        type: "series",
        extra: [{ name: "skip", isRequired: false }],
      },
    ]);
    expect(ids(await newTitles(accountId, "movie"))).toEqual([C]);
    expect(ids(await newTitles(accountId, "series"))).toEqual([E]);
    expect(await newTitles(accountId, "movie", "/search=Charlie")).toEqual([]);
    expect(await newTitles(accountId, "movie", "/skip=100")).toEqual([]);
  },
);

test(
  "the private copy of a Legacy alias install keeps the setting and starts its own Baseline",
  { tag: "@local" },
  async () => {
    const alias = "ur9999999999203";
    const legacyId = await seedAccount({
      legacyImdbUserId: alias,
      newTitlesCatalog: true,
    });
    const listId = await seedList(legacyId, {
      provider: "imdb",
      sourceRef: alias,
      catalogTitle: "QA alias",
      displayMode: "movie",
      position: 0,
    });
    const at = new Date().toISOString();
    await seedCachedCatalog(listId, [
      { ...CATALOG_TITLES[0], id: A, name: TITLES[A].name },
    ]);
    await seedDetectionHistory(
      legacyId,
      { provider: "imdb", sourceRef: alias },
      { baselineAt: at, lastSyncAt: at },
      [{ imdbId: A, detectedAt: at }],
    );
    expect(ids(await newTitles(alias))).toEqual([A]);

    writeSources(sources([A, B], [], {}, alias));
    const upgraded = await fetch(`${backend.url}/${alias}/upgrade`, {
      method: "POST",
    });
    expect(upgraded.status).toBe(200);
    const { accountId } = (await upgraded.json()) as { accountId: string };
    // The upgrade reads the copy's List once: that read is its Baseline.
    await expect.poll(() => syncRows(accountId)).toHaveLength(1);

    expect((await readConfig(accountId)).newTitles).toEqual({
      enabled: true,
      summary: { detected: 0, latestDetectedAt: null, waitingLists: 0 },
    });
    const manifest = (await (
      await fetch(`${backend.url}/${accountId}/manifest.json`)
    ).json()) as StremioManifest;
    expect(manifest.catalogs[0]).toMatchObject({ id: "new-titles-movie" });
    expect(await newTitles(accountId)).toEqual([]);

    await refreshAll(accountId, sources([A, B, C], [], {}, alias));
    expect(ids(await newTitles(accountId))).toEqual([C]);
    // The legacy Account keeps its own history.
    expect(await syncRows(legacyId)).toHaveLength(1);
    expect(ids(await newTitles(alias))).toEqual([A]);
  },
);

test(
  "a disconnect forgets only the history that the Connection could read",
  { tag: "@local" },
  async () => {
    const { accountId, listIds } = await seedDetectionAccount([
      { provider: "imdb", sourceRef: WATCHLIST, title: "QA watchlist" },
      { provider: "trakt", sourceRef: "me/history", title: "QA history" },
    ]);
    await seedConnection(accountId, "trakt", { username: TRAKT_USER });
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const history = [
      {
        listId: listIds[0],
        source: { provider: "imdb" as const, sourceRef: WATCHLIST },
        imdbId: A,
        at: daysAgo(2),
      },
      {
        listId: listIds[1],
        source: { provider: "trakt" as const, sourceRef: "me/history" },
        imdbId: B,
        at: daysAgo(1),
        connectionUser: TRAKT_USER,
      },
    ];
    for (const entry of history) {
      await seedCachedCatalog(entry.listId, [
        {
          ...CATALOG_TITLES[0],
          id: entry.imdbId,
          name: TITLES[entry.imdbId].name,
        },
      ]);
      await seedDetectionHistory(
        accountId,
        entry.source,
        {
          baselineAt: daysAgo(5),
          lastSyncAt: entry.at,
          connectionUser: entry.connectionUser,
        },
        [{ imdbId: entry.imdbId, detectedAt: entry.at }],
      );
    }
    expect(ids(await newTitles(accountId))).toEqual([B, A]);

    const disconnected = await fetch(
      `${backend.url}/${accountId}/connections/trakt`,
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(200);
    expect(
      (await syncRows(accountId)).map((row) => [row.provider, row.source_ref]),
    ).toEqual([["imdb", WATCHLIST]]);
    expect(ids(await newTitles(accountId))).toEqual([A]);
    // The history List cannot be read now, so it waits for a new Baseline.
    expect((await readConfig(accountId)).newTitles.summary).toEqual({
      detected: 1,
      latestDetectedAt: history[0].at,
      waitingLists: 1,
    });
  },
);

test(
  "Legacy alias requests never show Lists that need a Connection",
  { tag: "@local" },
  async () => {
    const alias = "ur9999999999202";
    const accountId = await seedAccount({
      legacyImdbUserId: alias,
      newTitlesCatalog: true,
    });
    const at = new Date().toISOString();
    const lists = [
      { provider: "imdb" as const, sourceRef: alias, id: A },
      { provider: "trakt" as const, sourceRef: "me/history", id: B },
    ];
    for (const [position, list] of lists.entries()) {
      const listId = await seedList(accountId, {
        provider: list.provider,
        sourceRef: list.sourceRef,
        catalogTitle: list.provider,
        displayMode: "movie",
        position,
      });
      await seedCachedCatalog(listId, [
        { ...CATALOG_TITLES[0], id: list.id, name: TITLES[list.id].name },
      ]);
      await seedDetectionHistory(
        accountId,
        list,
        { baselineAt: at, lastSyncAt: at },
        [{ imdbId: list.id, detectedAt: at }],
      );
    }

    const { status, metas } = await getCatalog(
      alias,
      "movie",
      "new-titles-movie",
    );
    expect(status).toBe(200);
    expect(metas.map((meta) => meta.id)).toEqual([A]);
  },
);

test(
  "a merged List detects in each Source list, shows a Title once and waits for each Baseline",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount({ newTitlesCatalog: true });
    const listId = await seedList(accountId, {
      provider: "imdb",
      sourceRef: WATCHLIST,
      catalogTitle: "QA merged",
      displayMode: "movie",
      sortOption: "added_at-asc",
      position: 0,
      mergedSources: [{ provider: "trakt", sourceRef: TRAKT_REF }],
    });

    // IMDb cannot be read: Trakt gets its Baseline, the List waits for IMDb.
    const first = await refreshAll(
      accountId,
      sources([], [traktItem(1, A)], { imdbFails: true }),
    );
    expect(first.newTitles).toEqual({
      detected: 0,
      latestDetectedAt: null,
      waitingLists: 1,
    });
    expect(await syncRows(accountId)).toMatchObject([
      { provider: "trakt", source_ref: TRAKT_REF },
    ]);

    // The first complete IMDb read is its own Baseline, B included.
    await refreshAll(accountId, sources([A, B], [traktItem(1, A)]));
    expect(await newTitles(accountId)).toEqual([]);

    // C reaches IMDb, then Trakt: one new title, with its first detection.
    await refreshAll(accountId, sources([A, B, C], [traktItem(1, A)]));
    const last = await refreshAll(
      accountId,
      sources([A, B, C], [traktItem(1, A), traktItem(3, C), traktItem(4, D)]),
    );
    const metas = await newTitles(accountId);
    expect(ids(metas)).toEqual([D, C]);
    expect(metas.map((meta) => meta.description)).toEqual([
      expect.stringMatching(new RegExp(`^${detected("QA merged")}`)),
      expect.stringMatching(new RegExp(`^${detected("QA merged")}`)),
    ]);
    expect(last.newTitles).toMatchObject({ detected: 2, waitingLists: 0 });
    const imdbC = (await entryRows(accountId)).filter(
      (row) => row.imdb_id === C,
    );
    expect(imdbC).toHaveLength(2);

    // IMDb fails again: nothing of it is removed, and Trakt, which dropped
    // A, is still compared.
    const before = (await entryRows(accountId)).filter(
      (row) => row.provider === "imdb",
    );
    await refreshAll(
      accountId,
      sources([], [traktItem(3, C), traktItem(4, D)], { imdbFails: true }),
    );
    const after = await entryRows(accountId);
    expect(after.filter((row) => row.provider === "imdb")).toEqual(before);
    expect(
      after.find((row) => row.provider === "trakt" && row.imdb_id === A)
        ?.removed_at,
    ).not.toBeNull();
    expect(ids(await newTitles(accountId))).toEqual([D, C]);

    // The List's own Catalog still shows the cached IMDb Titles.
    const served = await fetch(
      `${backend.url}/${accountId}/catalog/movie/wl-${listId}-movie.json`,
    );
    expect(
      ids(((await served.json()) as { metas: StremioMeta[] }).metas).sort(),
    ).toEqual([A, B, C, D]);
    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);
    await expect(
      page.getByText(/^2 new titles detected, the latest .+\.$/),
    ).toBeVisible();
  },
);

async function saveSettings(page: Page) {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await saveButton(page).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText(SAVED_REINSTALL)).toBeVisible();
}

test(
  "the configure page shows the detections and turns the catalog on and off",
  { tag: "@local" },
  async ({ page }) => {
    const { accountId } = await seedCatalog();
    const [first, second, third] = CATALOG_TITLES;
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    await seedDetectionHistory(
      accountId,
      { provider: "imdb", sourceRef: CATALOG_FIXTURE_USER },
      { baselineAt: daysAgo(5), lastSyncAt: daysAgo(2) },
      [
        { imdbId: first.id },
        { imdbId: second.id, detectedAt: daysAgo(3) },
        { imdbId: third.id, detectedAt: daysAgo(2) },
      ],
    );

    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);
    const toggle = page.getByRole("checkbox", {
      name: "Show newly detected titles",
    });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveAccessibleDescription(
      /^Adds a “New titles” catalog to Stremio with the titles that appear in your Lists/,
    );
    await expect(
      page.getByText("2 new titles detected, the latest 2 days ago."),
    ).toBeVisible();

    await toggle.click();
    await saveSettings(page);
    await page.reload();
    await expect(toggle).toBeChecked();

    const manifest = await getManifest(accountId);
    expect(manifest.catalogs[0]).toMatchObject({ id: "new-titles-movie" });
    const catalog = await getCatalog(accountId, "movie", "new-titles-movie");
    expect(catalog.metas.map((meta) => meta.id)).toEqual([third.id, second.id]);
    expect(catalog.metas[0].description).toMatch(
      /^Detected by Stremlist on \d{1,2} \w{3} \d{4} in Release QA\./,
    );

    // The reminder survives the reload until the user reinstalls.
    await page.getByRole("button", { name: "I did it" }).click();
    await expect(page.getByRole("button", { name: "I did it" })).toHaveCount(0);

    // Turning the catalog off removes it from the manifest: Stremio needs a
    // reinstall again.
    await toggle.click();
    await expect(
      page.getByText("These changes need a reinstall.", { exact: true }),
    ).toBeVisible();
    await saveSettings(page);
    expect(
      (await getManifest(accountId)).catalogs.map((catalog) => catalog.id),
    ).not.toContain("new-titles-movie");
    expect(await getCatalog(accountId, "movie", "new-titles-movie")).toEqual({
      status: 200,
      metas: [],
    });
  },
);
