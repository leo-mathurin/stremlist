import { expect, test } from "@playwright/test";
import type { ListSource } from "@stremlist/shared/list-merge";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { FRONTEND_URL } from "../env.js";
import {
  getCatalog,
  getConfig,
  getManifest,
  getMeta,
  postConfig,
} from "../helpers/api.js";
import {
  getListRows,
  resetDb,
  seedAccount,
  seedAccountWithLists,
  seedList,
} from "../helpers/db.js";
import {
  getCacheManifest,
  getCacheObjectKeys,
  seedCachedCatalog,
  sourceCacheKey,
} from "../helpers/r2.js";
import {
  CATALOG_FIXTURE_USER,
  CATALOG_FIXTURE_USER_2,
} from "../helpers/test-data.js";

// Merged Lists (STR-59, ADR 0006) against the real backend, Supabase and
// RustFS. Each Source list of a merged List has its own cache key; the
// synthetic watchlists are seeded there, so no Provider is read.

const FIRST: ListSource = { provider: "imdb", sourceRef: CATALOG_FIXTURE_USER };
const SECOND: ListSource = {
  provider: "imdb",
  sourceRef: CATALOG_FIXTURE_USER_2,
};
// Read through a Connection that the Account does not have: it always fails
// with "needs_connection", without a network call.
const NO_CONNECTION: ListSource = {
  provider: "trakt",
  sourceRef: "me/watchlist",
};

function title(
  id: string,
  addedAt: string,
  overrides: Partial<StremioMeta> = {},
): StremioMeta {
  // The cache keeps the date added next to the meta; Stremio never gets it.
  return {
    id,
    name: `QA ${id}`,
    type: "movie",
    poster: null,
    posterShape: "poster",
    genres: ["Drama"],
    description: "Merged List fixture",
    ...overrides,
    ...{ addedAt },
  };
}

/** A private Account with one merged List and its Source lists cached. */
async function seedMerged(
  sources: ListSource[],
  caches: (StremioMeta[] | null)[],
  overrides: { sortOption?: string; accountId?: string } = {},
) {
  const accountId = overrides.accountId ?? (await seedAccount());
  const [first, ...mergedSources] = sources;
  const listId = await seedList(accountId, {
    ...first,
    catalogTitle: "Merged QA",
    position: 0,
    sortOption: overrides.sortOption ?? "added_at-desc",
    displayMode: "movie",
    mergedSources,
  });
  for (const [index, metas] of caches.entries()) {
    if (metas) {
      await seedCachedCatalog(sourceCacheKey(listId, sources[index]), metas);
    }
  }
  return { accountId, listId, catalogId: `wl-${listId}-movie` };
}

test.beforeEach(resetDb);

test(
  "a merged List serves each Title once, sorted together by date added",
  { tag: "@local" },
  async () => {
    const { accountId, listId, catalogId } = await seedMerged(
      [FIRST, SECOND],
      [
        [
          title("tt9910001", "2020-01-01T00:00:00.000Z"),
          title("tt9910002", "2024-01-01T00:00:00.000Z"),
        ],
        [
          title("tt9910003", "2022-01-01T00:00:00.000Z"),
          // Also in the first Source list: it keeps its first date.
          title("tt9910001", "2025-01-01T00:00:00.000Z"),
        ],
      ],
    );

    const { status, metas } = await getCatalog(accountId, "movie", catalogId);
    expect(status).toBe(200);
    expect(metas.map((meta) => meta.id)).toEqual([
      "tt9910002",
      "tt9910003",
      "tt9910001",
    ]);
    expect(metas.some((meta) => "addedAt" in meta)).toBe(false);

    // One List, one Catalog in the manifest.
    const manifest = await getManifest(accountId);
    expect(manifest.catalogs.map((catalog) => catalog.id)).toEqual([catalogId]);
    // The meta route finds a Title of the second Source list, from its cache.
    const { meta } = await getMeta(accountId, "movie", "tt9910003");
    expect(meta?.name).toBe("QA tt9910003");
    expect(meta && "addedAt" in meta).toBe(false);

    const { body } = await getConfig(accountId);
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0]).toMatchObject({
      id: listId,
      provider: "imdb",
      sourceRef: CATALOG_FIXTURE_USER,
      mergedSources: [SECOND],
    });
  },
);

test(
  "a Source list that cannot be read leaves the other Source lists in the Catalog",
  { tag: "@local" },
  async () => {
    const { accountId, catalogId } = await seedMerged(
      [FIRST, NO_CONNECTION],
      [[title("tt9910001", "2020-01-01T00:00:00.000Z")], null],
    );
    const { status, metas } = await getCatalog(accountId, "movie", catalogId);
    expect(status).toBe(200);
    expect(metas.map((meta) => meta.id)).toEqual(["tt9910001"]);

    // When no Source list can be read, the card of the first problem shows.
    await resetDb();
    const failing = await seedMerged(
      [NO_CONNECTION, { provider: "trakt", sourceRef: "me/history" }],
      [null, null],
      { sortOption: "title-asc" },
    );
    const card = await getCatalog(
      failing.accountId,
      "movie",
      failing.catalogId,
    );
    expect(card.status).toBe(200);
    expect(card.metas.map((meta) => [meta.id, meta.name])).toEqual([
      [
        "stremlist:unavailable:needs_connection",
        "⚠️ This watchlist needs your Trakt account",
      ],
    ]);
  },
);

test(
  "a Legacy alias never serves or saves a merged List with a Connection Source list",
  { tag: "@local" },
  async () => {
    const alias = CATALOG_FIXTURE_USER;
    const accountId = await seedAccount({ legacyImdbUserId: alias });
    const merged = await seedMerged(
      [FIRST, { provider: "trakt", sourceRef: "me/history" }],
      [[title("tt9910001", "2020-01-01T00:00:00.000Z")], null],
      { accountId },
    );
    const plainId = await seedList(accountId, {
      ...SECOND,
      catalogTitle: "Plain QA",
      position: 1,
    });

    const manifest = await getManifest(alias);
    expect(manifest.catalogs.map((catalog) => catalog.id)).toEqual([
      `wl-${plainId}-movie`,
    ]);
    expect((await getCatalog(alias, "movie", merged.catalogId)).metas).toEqual(
      [],
    );
    expect(
      (await getConfig(alias)).body.lists.map((list) => list.catalogTitle),
    ).toEqual(["Plain QA"]);

    const refused = await postConfig(alias, [
      {
        ...SECOND,
        sortOption: "title-asc",
        mergedSources: [{ provider: "trakt", sourceRef: "me/history" }],
      },
    ]);
    expect(refused).toEqual({
      status: 400,
      body: {
        error:
          "Trakt lists need your private Addon URL. Upgrade this install first.",
      },
    });
  },
);

test(
  "the API refuses merges that break a rule and keeps the stored Lists",
  { tag: "@local" },
  async () => {
    const {
      accountId,
      listIds: [listId],
    } = await seedAccountWithLists([{ ...FIRST, catalogTitle: "Release QA" }]);
    const before = await getListRows(accountId);
    const cases: [unknown[], string][] = [
      [
        [
          { ...FIRST, sortOption: "title-asc", mergedSources: [SECOND] },
          { ...SECOND, sortOption: "title-asc" },
        ],
        "Each list can only be added once.",
      ],
      [
        [
          {
            ...FIRST,
            sortOption: "added_at-desc",
            mergedSources: [
              { provider: "imdb", sourceRef: "imdb:top-rated-movies" },
            ],
          },
        ],
        "Top 250 Movies does not give the date when each Title was added, so this List cannot sort by date added.",
      ],
      [
        [
          {
            ...FIRST,
            sortOption: "title-asc",
            displayMode: "series",
            mergedSources: [
              { provider: "imdb", sourceRef: "imdb:top-rated-movies" },
            ],
          },
        ],
        "Top 250 Movies has only movies, so this List cannot show only TV shows.",
      ],
      [
        [
          {
            ...FIRST,
            sortOption: "title-asc",
            mergedSources: ["ls1", "ls2", "ls3", "ls4", "ls5"].map(
              (sourceRef) => ({ provider: "imdb", sourceRef }),
            ),
          },
        ],
        "A List can merge at most 5 Source lists.",
      ],
      [
        // Four full Lists and one more: 21 Source lists in the Account.
        [
          ...[1, 2, 3, 4].map((group) => ({
            provider: "imdb" as const,
            sourceRef: `ls99${group}00000`,
            sortOption: "title-asc",
            mergedSources: [1, 2, 3, 4].map((n) => ({
              provider: "imdb" as const,
              sourceRef: `ls99${group}0000${n}`,
            })),
          })),
          { ...SECOND, sortOption: "title-asc" },
        ],
        "You can have at most 20 Source lists in all your Lists.",
      ],
    ];
    for (const [lists, error] of cases) {
      const response = await postConfig(
        accountId,
        lists as Parameters<typeof postConfig>[1],
      );
      expect(response).toEqual({ status: 400, body: { error } });
    }
    expect(await getListRows(accountId)).toEqual(before);
    expect(before[0].id).toBe(listId);
  },
);

test(
  "a save deletes the caches that it no longer uses",
  { tag: "@local" },
  async () => {
    const third: ListSource = {
      provider: "imdb",
      sourceRef: "ls9999999999998",
    };
    const { accountId, listId } = await seedMerged(
      [FIRST, SECOND, third],
      [
        [title("tt9910001", "2020-01-01T00:00:00.000Z")],
        [title("tt9910002", "2021-01-01T00:00:00.000Z")],
        [title("tt9910003", "2022-01-01T00:00:00.000Z")],
      ],
    );
    const prefix = (source: ListSource) =>
      `watchlists/${sourceCacheKey(listId, source)}/`;
    const keysOf = async (source: ListSource) =>
      (await getCacheObjectKeys(listId)).filter((key) =>
        key.startsWith(prefix(source)),
      );
    expect(await keysOf(third)).toHaveLength(2);

    // Removing one Source list drops only its cache.
    const removed = await postConfig(accountId, [
      {
        id: listId,
        ...FIRST,
        catalogTitle: "Merged QA",
        sortOption: "added_at-desc",
        displayMode: "movie",
        mergedSources: [SECOND],
      },
    ]);
    expect(removed.status).toBe(200);
    // A deleted cache keeps only a tombstone manifest (no generation).
    expect(await keysOf(third)).toEqual([`${prefix(third)}manifest.json`]);
    expect(await getCacheManifest(sourceCacheKey(listId, third))).toMatchObject(
      { deleted: true },
    );
    expect(await keysOf(FIRST)).toHaveLength(2);
    expect(await keysOf(SECOND)).toHaveLength(2);

    // Splitting the List back to one Source list drops every merged cache.
    const split = await postConfig(accountId, [
      {
        id: listId,
        ...FIRST,
        catalogTitle: "Merged QA",
        sortOption: "added_at-desc",
        displayMode: "movie",
        mergedSources: [],
      },
      { ...SECOND, sortOption: "title-asc", displayMode: "movie" },
    ]);
    expect(split.status).toBe(200);
    expect(
      (await getCacheObjectKeys(listId)).filter(
        (key) => key.includes("/sources/") && key.includes("/generations/"),
      ),
    ).toEqual([]);
    for (const source of [FIRST, SECOND]) {
      expect(
        await getCacheManifest(sourceCacheKey(listId, source)),
      ).toMatchObject({ deleted: true });
    }
    expect(
      (await getListRows(accountId)).map((row) => [
        row.source_ref,
        row.merged_sources,
      ]),
    ).toEqual([
      [CATALOG_FIXTURE_USER, []],
      [CATALOG_FIXTURE_USER_2, []],
    ]);
  },
);

test(
  "merging two Lists on the configure page saves and survives a reload",
  { tag: "@local" },
  async ({ page }) => {
    const {
      accountId,
      listIds: [firstId],
    } = await seedAccountWithLists([
      { ...FIRST, catalogTitle: "Release QA", sortOption: "added_at-desc" },
      { ...SECOND, catalogTitle: "Second QA", sortOption: "title-asc" },
    ]);
    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);
    await page.getByRole("button", { name: "Settings for Release QA" }).click();
    await page
      .getByRole("button", { name: "Merge another List into this one" })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Second QA" }).click();
    await expect(page.getByText("2 Source lists · IMDb")).toBeVisible();

    const response = page.waitForResponse(
      (res) =>
        res.url().endsWith("/config") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByText("Saved!", { exact: false })).toBeVisible();

    const rows = await getListRows(accountId);
    expect(
      rows.map((row) => [row.id, row.source_ref, row.merged_sources]),
    ).toEqual([
      [
        firstId,
        CATALOG_FIXTURE_USER,
        [
          {
            provider: "imdb",
            source_ref: CATALOG_FIXTURE_USER_2,
            label: "Second QA",
          },
        ],
      ],
    ]);
    expect(
      (await getManifest(accountId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([`wl-${firstId}-movie`]);

    await page.reload();
    await expect(page.getByText("2 Source lists · IMDb")).toBeVisible();
    await page.getByRole("button", { name: "Settings for Release QA" }).click();
    await expect(
      page.getByRole("button", { name: "Move Second QA to its own List" }),
    ).toBeVisible();
    await expect(page.getByText("2 of 5")).toBeVisible();
  },
);

/** The genre options of one manifest Catalog. */
async function genreOptions(accountId: string, catalogId: string) {
  const catalog = (await getManifest(accountId)).catalogs.find(
    (entry) => entry.id === catalogId,
  );
  return catalog?.extra?.find((extra) => extra.name === "genre")?.options;
}

test(
  "Source lists of different Providers share a Title once, with each link back",
  { tag: "@local" },
  async () => {
    // A public Trakt list needs no Connection; its cache answers the read.
    const trakt: ListSource = {
      provider: "trakt",
      sourceRef: "users/qa/lists/merged-qa",
    };
    const shared = "tt9910001";
    const { accountId, catalogId } = await seedMerged(
      [FIRST, trakt],
      [
        [
          title(shared, "2021-01-01T00:00:00.000Z", {
            name: "Bravo",
            description: `Merged List fixture\n\nMore on IMDb: https://www.imdb.com/title/${shared}/`,
          }),
          title("tt9910002", "2020-01-01T00:00:00.000Z", { name: "Charlie" }),
        ],
        [
          title(shared, "2019-01-01T00:00:00.000Z", {
            name: "Bravo",
            description:
              "Merged List fixture\n\nMore on Trakt: https://trakt.tv/movies/bravo",
          }),
          title("tt9910004", "2022-01-01T00:00:00.000Z", {
            name: "Alpha",
            genres: ["Western"],
          }),
        ],
      ],
      { sortOption: "title-asc" },
    );

    const { status, metas } = await getCatalog(accountId, "movie", catalogId);
    expect(status).toBe(200);
    expect(metas.map((meta) => [meta.id, meta.name])).toEqual([
      ["tt9910004", "Alpha"],
      [shared, "Bravo"],
      ["tt9910002", "Charlie"],
    ]);
    // The copy with the first date stays and gets the other link back.
    const bravo = metas.find((meta) => meta.id === shared);
    expect(bravo?.description).toBe(
      `Merged List fixture\n\nMore on Trakt: https://trakt.tv/movies/bravo\n\nMore on IMDb: https://www.imdb.com/title/${shared}/`,
    );
    const { meta } = await getMeta(accountId, "movie", shared);
    expect(meta?.description).toContain("More on Trakt:");
    expect(meta?.description).toContain("More on IMDb:");

    // The Catalog offers the genres of every Source list.
    expect(await genreOptions(accountId, catalogId)).toEqual(
      expect.arrayContaining(["Drama", "Western"]),
    );
  },
);

test(
  "a save that omits the merged Source lists keeps them and their labels",
  { tag: "@local" },
  async () => {
    // Clients from before merged Lists send no `mergedSources`.
    const accountId = await seedAccount();
    const listId = await seedList(accountId, {
      ...FIRST,
      catalogTitle: "Merged QA",
      position: 0,
      sortOption: "title-asc",
      sourceLabel: "Family picks",
      mergedSources: [{ ...SECOND, label: "Second QA" }],
    });
    const response = await postConfig(accountId, [
      {
        id: listId,
        ...FIRST,
        catalogTitle: "Renamed QA",
        sortOption: "title-desc",
      },
    ]);
    expect(response.status).toBe(200);
    const { body } = await getConfig(accountId);
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0]).toMatchObject({
      id: listId,
      catalogTitle: "Renamed QA",
      sortOption: "title-desc",
      sourceLabel: "Family picks",
      mergedSources: [{ ...SECOND, label: "Second QA" }],
    });
  },
);

test(
  "removing a merged Source list that is not the first changes the manifest genres without a reinstall message",
  { tag: "@local" },
  async ({ page }) => {
    // Known gap, reported and not fixed here: the reinstall signature of the
    // configure page (apps/frontend/src/lib/list-form.ts) has the first
    // Source list of each List but not its merged Source lists. Stremio
    // reads the genre options of a Catalog only at install time, so after
    // this save it still offers "Western", which no Source list has now.
    // When the page asks for a reinstall here, change the expected message.
    const western: ListSource = {
      provider: "imdb",
      sourceRef: "ls9999999999998",
      label: "Western QA",
    };
    const seed = () =>
      seedMerged(
        [FIRST, { ...SECOND, label: "Second QA" }, western],
        [
          [title("tt9910001", "2020-01-01T00:00:00.000Z")],
          [title("tt9910002", "2021-01-01T00:00:00.000Z")],
          [
            title("tt9910003", "2022-01-01T00:00:00.000Z", {
              genres: ["Western"],
            }),
          ],
        ],
        { sortOption: "title-asc" },
      );
    const { accountId, catalogId } = await seed();
    expect(await genreOptions(accountId, catalogId)).toEqual(
      expect.arrayContaining(["Drama", "Western"]),
    );

    await page.goto(`${FRONTEND_URL}/configure?account=${accountId}`);
    await page.getByRole("button", { name: "Settings for Merged QA" }).click();
    await page
      .getByRole("button", { name: "Remove Western QA from this List" })
      .click();
    await expect(page.getByText("2 of 5")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText(
        "Saved! Your catalogs will refresh with the new settings.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Reinstall Stremlist/)).toHaveCount(0);

    // The Catalog ID and its Titles follow the save without a reinstall, but
    // the genre options that Stremio read at install time are now different.
    expect(
      (await getManifest(accountId)).catalogs.map((catalog) => catalog.id),
    ).toEqual([catalogId]);
    const options = await genreOptions(accountId, catalogId);
    expect(options).toContain("Drama");
    expect(options).not.toContain("Western");
    expect(
      (await getCatalog(accountId, "movie", catalogId)).metas.map(
        (meta) => meta.id,
      ),
    ).toEqual(["tt9910001", "tt9910002"]);

    // For comparison: removing the first Source list asks for a reinstall,
    // although the manifest changes in the same way.
    await resetDb();
    const other = await seed();
    await page.goto(`${FRONTEND_URL}/configure?account=${other.accountId}`);
    await page.getByRole("button", { name: "Settings for Merged QA" }).click();
    await page
      .getByRole("button", { name: "Remove IMDb Watchlist from this List" })
      .click();
    await expect(page.getByText("2 of 5")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText(
        "Saved! Reinstall Stremlist in Stremio to see your new catalogs and Actions.",
      ),
    ).toBeVisible();
  },
);
