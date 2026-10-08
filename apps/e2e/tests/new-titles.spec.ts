import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  NewTitlesSummary,
  StremioManifest,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { FRONTEND_URL } from "../env.js";
import { getCatalog, getManifest } from "../helpers/api.js";
import { CATALOG_TITLES, seedCatalog } from "../helpers/catalog-fixture.js";
import {
  clearRefreshCooldown,
  db,
  resetDb,
  seedAccount,
  seedAccountWithLists,
  seedDetectionHistory,
  seedList,
} from "../helpers/db.js";
import { seedCachedCatalog } from "../helpers/r2.js";
import type {
  SourceFixture,
  SourceFixtureBackend,
} from "../helpers/source-fixture.js";
import { startSourceFixtureBackend } from "../helpers/source-fixture.js";
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
const TITLES: SourceFixture["titles"] = {
  [A]: { name: "QA Detection Alpha", year: 2001, type: "movie" },
  [B]: { name: "QA Detection Bravo", year: 2002, type: "movie" },
  [C]: { name: "QA Detection Charlie", year: 2003, type: "movie" },
  [D]: { name: "QA Detection Delta", year: 2004, type: "movie" },
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
  fail: { imdb?: boolean } = {},
): SourceFixture {
  return {
    imdb: { [WATCHLIST]: { ids: imdb, fail: fail.imdb } },
    trakt: { [TRAKT_USER]: { items: trakt } },
    titles: TITLES,
  };
}

function traktItem(trakt: number, imdb: string) {
  return { trakt, imdb, name: TITLES[imdb].name, year: TITLES[imdb].year };
}

let backend: SourceFixtureBackend;

test.beforeAll(async () => {
  backend = await startSourceFixtureBackend(sources([]));
});
test.afterAll(async () => {
  await backend?.stop();
});
test.beforeEach(async () => {
  await resetDb();
});

/** An Account with the New titles catalog on and these Lists. */
function seedDetectionAccount(
  lists: { provider: "imdb" | "trakt"; sourceRef: string; title: string }[],
) {
  return seedAccountWithLists(
    lists.map((list) => ({
      provider: list.provider,
      sourceRef: list.sourceRef,
      catalogTitle: list.title,
      displayMode: "movie" as const,
    })),
    { newTitlesCatalog: true },
  );
}

/** One synchronization of every List, as the Refresh button asks. */
async function refreshAll(accountId: string, state: SourceFixture) {
  backend.write(state);
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

async function newTitles(accountId: string): Promise<StremioMeta[]> {
  const response = await fetch(
    `${backend.url}/${accountId}/catalog/movie/new-titles-movie.json`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { metas: StremioMeta[] }).metas;
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

    const failed = await refreshAll(accountId, sources([], [], { imdb: true }));
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
      { provider: "imdb" as const, sourceRef: alias, title: "Public", id: A },
      {
        provider: "trakt" as const,
        sourceRef: "me/history",
        title: "History",
        id: B,
      },
    ];
    for (const [position, list] of lists.entries()) {
      const listId = await seedList(accountId, {
        provider: list.provider,
        sourceRef: list.sourceRef,
        catalogTitle: list.title,
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

async function saveSettings(page: Page) {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(
    page.getByText(
      "Saved! Reinstall Stremlist in Stremio to see your new catalogs and Actions.",
    ),
  ).toBeVisible();
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

    await toggle.click();
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
