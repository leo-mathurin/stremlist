import { expect, test } from "@playwright/test";
import type { ConfigListInput } from "@stremlist/shared/stremio.types";
import { FRONTEND_URL, BACKEND_URL } from "../env.js";
import {
  asInput,
  bootstrapLegacy,
  createAccount,
  getBaseManifest,
  getCatalog,
  getConfig,
  getManifest,
  getMeta,
  postConfig,
  refresh,
  resolveLink,
  type CatalogMeta,
} from "../helpers/api.js";
import {
  clearRefreshCooldown,
  getAccountByLegacyAlias,
  getListRows,
  resetDb,
  seedAccountWithLists,
} from "../helpers/db.js";
import {
  countCacheObjects,
  getCacheManifest,
  getCacheObjectKeys,
} from "../helpers/r2.js";
import {
  MALFORMED_USER,
  P_HANDLE,
  PRIVATE_LIST,
  PRIVATE_P_HANDLE,
  PRIVATE_USER,
  PUBLIC_LIST,
  PUBLIC_USER,
  UNKNOWN_LIST,
  UNKNOWN_USER,
} from "../helpers/test-data.js";

// Addon protocol contract — the exact HTTP surface every Stremio client
// (web, desktop, mobile) consumes. Data comes from live IMDb, so assertions
// are structural: ordering invariants, id shapes, counts.

const CATALOG_ID_PATTERN =
  /^wl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(movie|series)$/;

/** A private Account whose only List is one IMDb Source list (no prewarm). */
async function seedImdbAccount(sourceRef = PUBLIC_USER) {
  const {
    accountId,
    listIds: [listId],
  } = await seedAccountWithLists([
    { sourceRef, catalogTitle: "", displayMode: "split" },
  ]);
  return { accountId, listId };
}

const imdbList = (
  sourceRef: string,
  extra: Partial<ConfigListInput> = {},
): ConfigListInput => ({
  provider: "imdb",
  sourceRef,
  sortOption: "added_at-asc",
  ...extra,
});

test.beforeEach(async () => {
  await resetDb();
});

test.describe("manifest", () => {
  test("base manifest requires configuration", { tag: "@local" }, async () => {
    const manifest = await getBaseManifest();
    expect(manifest.behaviorHints?.configurationRequired).toBe(true);
    expect(manifest.behaviorHints?.configurable).toBe(true);
    expect(manifest.name).toBe("Stremlist");
  });

  test(
    "first Legacy alias manifest bootstraps the install",
    { tag: "@local" },
    async () => {
      const manifest = await getManifest(PUBLIC_USER);
      expect(manifest.id).toBe(`com.stremlist.${PUBLIC_USER}`);
      expect(manifest.behaviorHints?.configurationRequired).toBe(false);
      // Default watchlist in split mode → one movie + one series catalog.
      expect(manifest.catalogs).toHaveLength(2);
      expect(manifest.catalogs.map((c) => c.type).sort()).toEqual([
        "movie",
        "series",
      ]);
      for (const catalogRef of manifest.catalogs) {
        expect(catalogRef.id).toMatch(CATALOG_ID_PATTERN);
        expect(catalogRef.name).toContain("Stremlist");
      }
      // The meta resource must stay declared — Stremio clients rely on it.
      const metaResource = manifest.resources.find(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          (r as { name?: string }).name === "meta",
      ) as { idPrefixes?: string[] } | undefined;
      expect(metaResource?.idPrefixes).toEqual(["tt"]);

      // The install got a legacy Account with one IMDb watchlist List.
      const account = await getAccountByLegacyAlias(PUBLIC_USER);
      expect(account).not.toBeNull();
      expect(await getListRows(account!.id)).toMatchObject([
        { provider: "imdb", source_ref: PUBLIC_USER, position: 0 },
      ]);
      const config = await getConfig(PUBLIC_USER);
      expect(config.body).toMatchObject({ access: "legacy", accountId: null });
    },
  );

  test(
    "a private Addon URL manifest does not expose the Account ID",
    { tag: "@local" },
    async () => {
      const { accountId } = await seedImdbAccount();
      const manifest = await getManifest(accountId);
      expect(manifest.id).toMatch(/^com\.stremlist\.[0-9a-f]{16}$/);
      expect(JSON.stringify(manifest)).not.toContain(accountId);
      expect(manifest.catalogs).toHaveLength(2);
      const config = await getConfig(accountId);
      expect(config.body).toMatchObject({ access: "private", accountId });
    },
  );

  test(
    "display mode controls emitted catalogs",
    { tag: "@local" },
    async () => {
      const { accountId, listId } = await seedImdbAccount();
      const saved = await postConfig(accountId, [
        imdbList(PUBLIC_USER, { id: listId, displayMode: "movie" }),
      ]);
      expect(saved.status).toBe(200);
      const manifest = await getManifest(accountId);
      expect(manifest.catalogs).toHaveLength(1);
      expect(manifest.catalogs[0].type).toBe("movie");
    },
  );

  test(
    "rejects malformed installation IDs",
    { tag: "@local" },
    async ({ request }) => {
      for (const key of [MALFORMED_USER, "sl_tooShort"]) {
        const response = await request.get(
          `${BACKEND_URL}/${key}/manifest.json`,
        );
        expect(response.status()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          behaviorHints: {
            configurable: true,
            configurationRequired: true,
          },
        });
      }
    },
  );
});

test.describe("catalogs", () => {
  test(
    "movie catalog serves the live IMDb watchlist",
    { tag: "@live-smoke" },
    async () => {
      const { accountId, listId } = await seedImdbAccount();
      const catalogId = `wl-${listId}-movie`;
      const { status, metas } = await getCatalog(accountId, "movie", catalogId);
      expect(status).toBe(200);
      expect(metas.length).toBeGreaterThan(0);
      for (const meta of metas) {
        expect(meta.type).toBe("movie");
        expect(meta.id).toMatch(/^tt\d+$/);
        expect(meta.name.length).toBeGreaterThan(0);
      }
      // One manifest and one compressed catalog generation are persisted.
      expect(await countCacheObjects(listId)).toBe(2);
    },
  );

  test(
    "every sort option orders the catalog correctly",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId } = await seedImdbAccount();
      const catalogId = `wl-${listId}-movie`;

      const setSort = async (sortOption: string) => {
        const { status } = await postConfig(accountId, [
          imdbList(PUBLIC_USER, { id: listId, sortOption }),
        ]);
        expect(status).toBe(200);
        const { metas } = await getCatalog(accountId, "movie", catalogId);
        return metas;
      };

      const baseline = await setSort("added_at-asc");
      expect(baseline.length).toBeGreaterThan(1);
      const ids = (metas: CatalogMeta[]) => metas.map((m) => m.id);
      const years = (metas: CatalogMeta[]) =>
        metas.map((m) => parseInt(m.releaseInfo ?? "0", 10) || 0);
      const ratings = (metas: CatalogMeta[]) =>
        metas.map((m) => parseFloat(m.imdbRating ?? "0") || 0);
      const expectMonotonic = (values: number[], direction: "asc" | "desc") => {
        for (let i = 1; i < values.length; i++) {
          if (direction === "asc")
            expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
          else expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
        }
      };

      const addedDesc = await setSort("added_at-desc");
      expect(ids(addedDesc)).toEqual([...ids(baseline)].reverse());

      const titleAsc = await setSort("title-asc");
      const namesAsc = titleAsc.map((m) => m.name);
      expect(namesAsc).toEqual(
        [...namesAsc].sort((a, b) => a.localeCompare(b)),
      );

      const titleDesc = await setSort("title-desc");
      const namesDesc = titleDesc.map((m) => m.name);
      expect(namesDesc).toEqual(
        [...namesDesc].sort((a, b) => b.localeCompare(a)),
      );

      expectMonotonic(years(await setSort("year-asc")), "asc");
      expectMonotonic(years(await setSort("year-desc")), "desc");
      expectMonotonic(ratings(await setSort("rating-asc")), "asc");
      expectMonotonic(ratings(await setSort("rating-desc")), "desc");

      const random = await setSort("random");
      expect(ids(random).sort()).toEqual(ids(baseline).sort());
    },
  );

  test(
    "ls list source serves a public IMDb list",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId } = await seedImdbAccount();
      expect(
        (await postConfig(accountId, [imdbList(PUBLIC_LIST)])).status,
      ).toBe(200);
      const updated = await getConfig(accountId);
      const list = updated.body.lists[0];
      expect(list).toMatchObject({ provider: "imdb", sourceRef: PUBLIC_LIST });
      const { metas } = await getCatalog(
        accountId,
        "movie",
        `wl-${list.id}-movie`,
      );
      expect(metas.length).toBeGreaterThan(0);
      expect(listId).not.toBe(list.id);
    },
  );

  test(
    "built-in chart catalog serves live chart data",
    { tag: "@live-regression" },
    async () => {
      const { accountId } = await seedImdbAccount();
      await postConfig(accountId, [
        imdbList("imdb:top-rated-movies", { displayMode: "movie" }),
      ]);
      const { body } = await getConfig(accountId);
      const chart = body.lists[0];
      const pages = await Promise.all(
        [0, 100, 200].map((skip) =>
          getCatalog(accountId, "movie", `wl-${chart.id}-movie`, skip),
        ),
      );
      for (const page of pages) expect(page.status).toBe(200);
      expect(pages[0].metas).toHaveLength(100);
      expect(pages[1].metas).toHaveLength(100);
      expect(pages[2].metas.length).toBeGreaterThan(0);

      const metas = pages.flatMap((page) => page.metas);
      // IMDb Top 250. Allow slack for titles Stremio types cannot represent,
      // but make sure pagination neither duplicates nor drops a whole page.
      expect(metas.length).toBeGreaterThan(200);
      expect(new Set(metas.map((meta) => meta.id)).size).toBe(metas.length);
      for (const meta of metas.slice(0, 10)) {
        expect(meta.type).toBe("movie");
        expect(meta.id).toMatch(/^tt\d+$/);
      }
    },
  );

  test("RPDB key rewrites posters", { tag: "@live-regression" }, async () => {
    const { accountId, listId } = await seedImdbAccount();
    await postConfig(accountId, [imdbList(PUBLIC_USER, { id: listId })], {
      rpdbApiKey: "e2e-test-key",
    });
    const { metas } = await getCatalog(
      accountId,
      "movie",
      `wl-${listId}-movie`,
    );
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) {
      expect(meta.poster).toContain(
        "https://api.ratingposterdb.com/e2e-test-key/imdb/poster-default/",
      );
    }
  });

  test(
    "unknown watchlist degrades to an informational card, not a 500",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId } = await seedImdbAccount(UNKNOWN_USER);
      const { status, metas } = await getCatalog(
        accountId,
        "movie",
        `wl-${listId}-movie`,
      );
      expect(status).toBe(200);
      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe("stremlist:unavailable:not_found");
      expect(metas[0].name).toContain("IMDb could not find this watchlist");
    },
  );

  test(
    "private watchlist degrades to an informational card",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId } = await seedImdbAccount(PRIVATE_USER);
      const { status, metas } = await getCatalog(
        accountId,
        "movie",
        `wl-${listId}-movie`,
      );
      expect(status).toBe(200);
      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe("stremlist:unavailable:private");
      expect(metas[0].name).toContain("This IMDb watchlist is private");
    },
  );

  test(
    "malformed catalog requests return empty catalogs",
    { tag: "@local" },
    async () => {
      const { accountId } = await seedImdbAccount();
      const unknownCatalog = await getCatalog(
        accountId,
        "movie",
        "wl-00000000-0000-4000-8000-000000000000-movie",
      );
      expect(unknownCatalog.status).toBe(200);
      expect(unknownCatalog.metas).toEqual([]);

      const badType = await getCatalog(
        accountId,
        "channel",
        "stremlist-movies",
      );
      expect(badType.status).toBe(200);
      expect(badType.metas).toEqual([]);
    },
  );

  test(
    "removing a List deletes cached generations and leaves a tombstone",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId: removed } = await seedImdbAccount();
      const created = await postConfig(accountId, [
        imdbList(PUBLIC_USER, { id: removed }),
        imdbList(PUBLIC_LIST),
      ]);
      expect(created.status).toBe(200);

      const current = (await getConfig(accountId)).body.lists;
      const kept = current.find((list) => list.id !== removed);
      expect(kept).toBeDefined();

      await getCatalog(accountId, "movie", `wl-${removed}-movie`);
      expect(await countCacheObjects(removed)).toBe(2);

      const updated = await postConfig(accountId, asInput([kept!]));
      expect(updated.status).toBe(200);
      expect(await getCacheObjectKeys(removed)).toEqual([
        `watchlists/${removed}/manifest.json`,
      ]);
      expect(await getCacheManifest(removed)).toMatchObject({
        version: 1,
        deleted: true,
      });
    },
  );
});

test.describe("meta", () => {
  test(
    "serves cached meta and falls back to null on misses",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId } = await seedImdbAccount();
      const catalogId = `wl-${listId}-movie`;
      const { metas } = await getCatalog(accountId, "movie", catalogId);
      const first = metas[0];

      const hit = await getMeta(accountId, "movie", first.id);
      expect(hit.status).toBe(200);
      expect(hit.meta?.name).toBe(first.name);
      expect(hit.meta?.id).toBe(first.id);

      // Cache-only: unknown ids must return null (Stremio then asks Cinemeta),
      // never 500.
      const miss = await getMeta(accountId, "movie", "tt9999999999");
      expect(miss.status).toBe(200);
      expect(miss.meta).toBeNull();
    },
  );
});

test.describe("link resolution", () => {
  test(
    "resolves public, unknown, and p-handle IMDb links",
    { tag: "@live-regression" },
    async () => {
      expect(
        await resolveLink(`https://www.imdb.com/user/${PUBLIC_USER}/watchlist`),
      ).toEqual({
        ok: true,
        provider: "imdb",
        sourceRef: PUBLIC_USER,
        kind: "watchlist",
        requiresConnection: false,
        suggestedTitle: null,
        defaultDisplayMode: null,
      });
      expect(await resolveLink(UNKNOWN_USER)).toEqual({
        ok: false,
        reason: "not_found",
        provider: "imdb",
      });
      expect(
        await resolveLink(`https://www.imdb.com/list/${PUBLIC_LIST}/`),
      ).toMatchObject({
        ok: true,
        provider: "imdb",
        sourceRef: PUBLIC_LIST,
        kind: "list",
      });
      expect(await resolveLink(UNKNOWN_LIST)).toEqual({
        ok: false,
        reason: "not_found",
        provider: "imdb",
      });

      // p-handles resolve to a canonical ur id first. The target account's
      // watchlist visibility is not under our control, so only assert shape.
      const handleResult = await resolveLink(
        `https://www.imdb.com/user/${P_HANDLE}/`,
      );
      if (handleResult.ok) {
        expect(String(handleResult.sourceRef)).toMatch(/^ur\d+$/);
      } else {
        expect(["private", "not_found"]).toContain(handleResult.reason);
      }
    },
  );

  test("reports private sources", { tag: "@live-regression" }, async () => {
    expect(await resolveLink(PRIVATE_USER)).toEqual({
      ok: false,
      reason: "private",
      provider: "imdb",
    });
    // Same account via its p-handle: exercises handle resolution on a
    // private source.
    expect(await resolveLink(PRIVATE_P_HANDLE)).toEqual({
      ok: false,
      reason: "private",
      provider: "imdb",
    });
    if (PRIVATE_LIST) {
      expect(await resolveLink(PRIVATE_LIST)).toEqual({
        ok: false,
        reason: "private",
        provider: "imdb",
      });
    }
  });

  test(
    "unrecognized links and charts resolve without a Provider call",
    { tag: "@local" },
    async () => {
      expect(await resolveLink("banana bread")).toEqual({
        ok: false,
        reason: "unrecognized",
      });
      expect(await resolveLink("imdb:box-office")).toEqual({
        ok: true,
        provider: "imdb",
        sourceRef: "imdb:box-office",
        kind: "chart",
        requiresConnection: false,
        suggestedTitle: "Box Office (Weekend)",
        defaultDisplayMode: "movie",
      });
      // MDBList Source lists always read through a Connection.
      expect(
        await resolveLink("https://mdblist.com/lists/someone/some-list"),
      ).toEqual({
        ok: false,
        reason: "needs_connection",
        provider: "mdblist",
      });
    },
  );
});

test.describe("config API", () => {
  test("rejects invalid configurations", { tag: "@local" }, async () => {
    const { accountId } = await seedImdbAccount();
    const valid = imdbList(PUBLIC_USER);
    const status = async (lists: ConfigListInput[]) =>
      (await postConfig(accountId, lists)).status;

    expect(await status([])).toBe(400);
    expect(await status(Array.from({ length: 11 }, () => valid))).toBe(400);
    expect(await status([{ ...valid, catalogTitle: "x".repeat(61) }])).toBe(
      400,
    );
    expect(await status([{ ...valid, sortOption: "bogus" }])).toBe(400);
    expect(await status([valid, valid])).toBe(400);
    expect(await status([{ ...valid, sourceRef: "banana" }])).toBe(400);
    // A Source list that needs a Connection the Account does not have.
    const needsConnection = await postConfig(accountId, [
      {
        provider: "simkl",
        sourceRef: "me/plantowatch",
        sortOption: "title-asc",
      },
    ]);
    expect(needsConnection).toEqual({
      status: 400,
      body: { error: "Connect your Simkl account first." },
    });
    // Nothing above changed the stored configuration.
    expect((await getConfig(accountId)).body.lists).toMatchObject([
      { provider: "imdb", sourceRef: PUBLIC_USER, sortOption: "added_at-asc" },
    ]);
  });

  test(
    "a new Account starts from its first Lists",
    { tag: "@local" },
    async () => {
      const created = await createAccount(
        [imdbList("imdb:box-office", { displayMode: "movie" })],
        "e2e-rpdb",
      );
      expect(created.status).toBe(200);
      const accountId = created.body.accountId!;
      expect(accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
      const { body } = await getConfig(accountId);
      expect(body).toMatchObject({
        access: "private",
        accountId,
        rpdbApiKey: "e2e-rpdb",
        connections: [],
        actions: { enabled: false, providers: [] },
        lists: [{ provider: "imdb", sourceRef: "imdb:box-office" }],
      });
      // Creation validates like a save.
      expect((await createAccount([imdbList("banana")])).status).toBe(400);
    },
  );

  test(
    "404s for Addon URLs that never installed",
    { tag: "@local" },
    async () => {
      expect((await getConfig(PUBLIC_USER)).status).toBe(404);
      expect((await getConfig("sl_0000000000000000000000")).status).toBe(404);
    },
  );
});

test.describe("refresh", () => {
  test(
    "refreshes from live IMDb and then throttles",
    { tag: "@live-regression" },
    async () => {
      const { accountId, listId } = await seedImdbAccount();
      await clearRefreshCooldown(accountId);

      const first = await refresh(accountId);
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(first.body.refreshed).toBe(1);
      expect(first.body.failed).toBe(0);
      expect(first.body.total).toBe(1);
      expect(await countCacheObjects(listId)).toBe(2);

      const second = await refresh(accountId);
      expect(second.body.throttled).toBe(true);
    },
  );
});

test.describe("misc endpoints", () => {
  test("health, stats, and configure redirect", { tag: "@local" }, async () => {
    const health = await fetch(`${BACKEND_URL}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { database: string }).database).toBe("up");

    const { accountId } = await seedImdbAccount();
    await bootstrapLegacy(PUBLIC_USER);
    const stats = await fetch(`${BACKEND_URL}/stats`);
    expect(
      ((await stats.json()) as { activeUsers: number }).activeUsers,
    ).toBeGreaterThanOrEqual(2);

    for (const key of [accountId, PUBLIC_USER]) {
      const configure = await fetch(`${BACKEND_URL}/${key}/configure`, {
        redirect: "manual",
      });
      expect(configure.status).toBe(302);
      expect(configure.headers.get("location")).toBe(
        `${FRONTEND_URL}/configure?account=${key}`,
      );
    }
  });
});
