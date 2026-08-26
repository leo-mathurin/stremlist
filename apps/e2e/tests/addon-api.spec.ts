import { expect, test } from "@playwright/test";
import { FRONTEND_URL, BACKEND_URL } from "../env.js";
import {
  bootstrapUser,
  getBaseManifest,
  getCatalog,
  getConfig,
  getMeta,
  getUserManifest,
  postConfig,
  refresh,
  validateList,
  validateUser,
  type CatalogMeta,
} from "../helpers/api.js";
import { clearRefreshCooldown, resetDb } from "../helpers/db.js";
import { countCacheObjects } from "../helpers/r2.js";
import {
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
    "first user manifest bootstraps the install",
    { tag: "@local" },
    async () => {
      const manifest = await getUserManifest(PUBLIC_USER);
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
    },
  );

  test(
    "display mode controls emitted catalogs",
    { tag: "@local" },
    async () => {
      const config = await bootstrapUser(PUBLIC_USER);
      const watchlist = config.watchlists[0];
      await postConfig(PUBLIC_USER, [
        {
          id: watchlist.id,
          imdbUserId: watchlist.imdbUserId,
          sortOption: "added_at-asc",
          displayMode: "movie",
        },
      ]);
      const manifest = await getUserManifest(PUBLIC_USER);
      expect(manifest.catalogs).toHaveLength(1);
      expect(manifest.catalogs[0].type).toBe("movie");
    },
  );
});

test.describe("catalogs", () => {
  test(
    "movie catalog serves the live IMDb watchlist",
    { tag: "@live-smoke" },
    async () => {
      const config = await bootstrapUser(PUBLIC_USER);
      const catalogId = `wl-${config.watchlists[0].id}-movie`;
      const { status, metas } = await getCatalog(
        PUBLIC_USER,
        "movie",
        catalogId,
      );
      expect(status).toBe(200);
      expect(metas.length).toBeGreaterThan(0);
      for (const meta of metas) {
        expect(meta.type).toBe("movie");
        expect(meta.id).toMatch(/^tt\d+$/);
        expect(meta.name.length).toBeGreaterThan(0);
      }
      // One manifest and one compressed catalog generation are persisted.
      expect(await countCacheObjects(config.watchlists[0].id)).toBe(2);
    },
  );

  test(
    "every sort option orders the catalog correctly",
    { tag: "@live-regression" },
    async () => {
      const config = await bootstrapUser(PUBLIC_USER);
      const watchlist = config.watchlists[0];
      const catalogId = `wl-${watchlist.id}-movie`;

      const setSort = async (sortOption: string) => {
        const { status } = await postConfig(PUBLIC_USER, [
          { id: watchlist.id, imdbUserId: watchlist.imdbUserId, sortOption },
        ]);
        expect(status).toBe(200);
        const { metas } = await getCatalog(PUBLIC_USER, "movie", catalogId);
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
      const config = await bootstrapUser(PUBLIC_USER);
      await postConfig(PUBLIC_USER, [
        { imdbUserId: PUBLIC_LIST, sortOption: "added_at-asc" },
      ]);
      const updated = await getConfig(PUBLIC_USER);
      const watchlist = updated.body.watchlists[0];
      expect(watchlist.imdbUserId).toBe(PUBLIC_LIST);
      const { metas } = await getCatalog(
        PUBLIC_USER,
        "movie",
        `wl-${watchlist.id}-movie`,
      );
      expect(metas.length).toBeGreaterThan(0);
      expect(config.watchlists[0].id).not.toBe(watchlist.id);
    },
  );

  test(
    "built-in chart catalog serves live chart data",
    { tag: "@live-regression" },
    async () => {
      await bootstrapUser(PUBLIC_USER);
      await postConfig(PUBLIC_USER, [
        {
          imdbUserId: "imdb:top-rated-movies",
          sortOption: "added_at-asc",
          displayMode: "movie",
        },
      ]);
      const { body } = await getConfig(PUBLIC_USER);
      const chart = body.watchlists[0];
      const firstPage = await getCatalog(
        PUBLIC_USER,
        "movie",
        `wl-${chart.id}-movie`,
      );
      const secondPage = await getCatalog(
        PUBLIC_USER,
        "movie",
        `wl-${chart.id}-movie`,
        100,
      );
      const thirdPage = await getCatalog(
        PUBLIC_USER,
        "movie",
        `wl-${chart.id}-movie`,
        200,
      );
      expect(firstPage.status).toBe(200);
      expect(secondPage.status).toBe(200);
      expect(thirdPage.status).toBe(200);
      expect(firstPage.metas).toHaveLength(100);
      expect(secondPage.metas).toHaveLength(100);
      expect(thirdPage.metas.length).toBeGreaterThan(0);

      const metas = [
        ...firstPage.metas,
        ...secondPage.metas,
        ...thirdPage.metas,
      ];
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
    const config = await bootstrapUser(PUBLIC_USER);
    const watchlist = config.watchlists[0];
    await postConfig(
      PUBLIC_USER,
      [
        {
          id: watchlist.id,
          imdbUserId: watchlist.imdbUserId,
          sortOption: "added_at-asc",
        },
      ],
      "e2e-test-key",
    );
    const { metas } = await getCatalog(
      PUBLIC_USER,
      "movie",
      `wl-${watchlist.id}-movie`,
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
      const config = await bootstrapUser(UNKNOWN_USER);
      const { status, metas } = await getCatalog(
        UNKNOWN_USER,
        "movie",
        `wl-${config.watchlists[0].id}-movie`,
      );
      expect(status).toBe(200);
      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe("stremlist:unavailable:not_found");
      expect(metas[0].name).toContain("not found");
    },
  );

  test(
    "private watchlist degrades to an informational card",
    { tag: "@live-regression" },
    async () => {
      const config = await bootstrapUser(PRIVATE_USER);
      const { status, metas } = await getCatalog(
        PRIVATE_USER,
        "movie",
        `wl-${config.watchlists[0].id}-movie`,
      );
      expect(status).toBe(200);
      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe("stremlist:unavailable:private");
      expect(metas[0].name).toContain("private");
    },
  );

  test(
    "malformed catalog requests return empty catalogs",
    { tag: "@local" },
    async () => {
      await bootstrapUser(PUBLIC_USER);
      const unknownCatalog = await getCatalog(
        PUBLIC_USER,
        "movie",
        "wl-00000000-0000-4000-8000-000000000000-movie",
      );
      expect(unknownCatalog.status).toBe(200);
      expect(unknownCatalog.metas).toEqual([]);

      const badType = await getCatalog(
        PUBLIC_USER,
        "channel",
        "stremlist-movies",
      );
      expect(badType.status).toBe(200);
      expect(badType.metas).toEqual([]);
    },
  );

  test(
    "removing a watchlist deletes its R2 cache objects",
    { tag: "@live-regression" },
    async () => {
      const config = await bootstrapUser(PUBLIC_USER);
      const removed = config.watchlists[0];
      const created = await postConfig(PUBLIC_USER, [
        {
          id: removed.id,
          imdbUserId: removed.imdbUserId,
          sortOption: removed.sortOption,
        },
        { imdbUserId: PUBLIC_LIST, sortOption: "added_at-asc" },
      ]);
      expect(created.status).toBe(200);

      const current = (await getConfig(PUBLIC_USER)).body.watchlists;
      const kept = current.find((watchlist) => watchlist.id !== removed.id);
      expect(kept).toBeDefined();

      await getCatalog(PUBLIC_USER, "movie", `wl-${removed.id}-movie`);
      expect(await countCacheObjects(removed.id)).toBe(2);

      const updated = await postConfig(PUBLIC_USER, [
        {
          id: kept!.id,
          imdbUserId: kept!.imdbUserId,
          sortOption: kept!.sortOption,
        },
      ]);
      expect(updated.status).toBe(200);
      expect(await countCacheObjects(removed.id)).toBe(0);
    },
  );
});

test.describe("meta", () => {
  test(
    "serves cached meta and falls back to null on misses",
    { tag: "@live-regression" },
    async () => {
      const config = await bootstrapUser(PUBLIC_USER);
      const catalogId = `wl-${config.watchlists[0].id}-movie`;
      const { metas } = await getCatalog(PUBLIC_USER, "movie", catalogId);
      const first = metas[0];

      const hit = await getMeta(PUBLIC_USER, "movie", first.id);
      expect(hit.status).toBe(200);
      expect(hit.meta?.name).toBe(first.name);
      expect(hit.meta?.id).toBe(first.id);

      // Cache-only: unknown ids must return null (Stremio then asks Cinemeta),
      // never 500.
      const miss = await getMeta(PUBLIC_USER, "movie", "tt9999999999");
      expect(miss.status).toBe(200);
      expect(miss.meta).toBeNull();
    },
  );
});

test.describe("validation endpoints", () => {
  test(
    "validates public, unknown, and p-handle sources",
    { tag: "@live-regression" },
    async () => {
      expect(await validateUser(PUBLIC_USER)).toEqual({
        valid: true,
        userId: PUBLIC_USER,
      });
      expect(await validateUser(UNKNOWN_USER)).toEqual({
        valid: false,
        reason: "not_found",
      });
      expect(await validateList(PUBLIC_LIST)).toEqual({ valid: true });
      expect(await validateList(UNKNOWN_LIST)).toEqual({
        valid: false,
        reason: "not_found",
      });

      // p-handles resolve to a canonical ur id first. The target account's
      // watchlist visibility is not under our control, so only assert shape.
      const handleResult = await validateUser(P_HANDLE);
      if (handleResult.valid) {
        expect(String(handleResult.userId)).toMatch(/^ur\d+$/);
      } else {
        expect(["private", "not_found"]).toContain(handleResult.reason);
      }
    },
  );

  test("reports private sources", { tag: "@live-regression" }, async () => {
    expect(await validateUser(PRIVATE_USER)).toEqual({
      valid: false,
      reason: "private",
    });
    // Same account via its p-handle: exercises handle resolution on a
    // private source.
    expect(await validateUser(PRIVATE_P_HANDLE)).toEqual({
      valid: false,
      reason: "private",
    });
    if (PRIVATE_LIST) {
      expect(await validateList(PRIVATE_LIST)).toEqual({
        valid: false,
        reason: "private",
      });
    }
  });
});

test.describe("config API", () => {
  test("rejects invalid configurations", { tag: "@local" }, async () => {
    await bootstrapUser(PUBLIC_USER);
    const valid = { imdbUserId: PUBLIC_USER, sortOption: "added_at-asc" };

    expect((await postConfig(PUBLIC_USER, [])).status).toBe(400);
    expect(
      (
        await postConfig(
          PUBLIC_USER,
          Array.from({ length: 11 }, () => valid),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await postConfig(PUBLIC_USER, [
          { ...valid, catalogTitle: "x".repeat(31) },
        ])
      ).status,
    ).toBe(400);
    expect(
      (await postConfig(PUBLIC_USER, [{ ...valid, sortOption: "bogus" }]))
        .status,
    ).toBe(400);
    expect((await postConfig(PUBLIC_USER, [valid, valid])).status).toBe(400);
    expect(
      (await postConfig(PUBLIC_USER, [{ ...valid, imdbUserId: "banana" }]))
        .status,
    ).toBe(400);
  });

  test("404s for users that never installed", { tag: "@local" }, async () => {
    const { status } = await getConfig(PUBLIC_USER);
    expect(status).toBe(404);
  });
});

test.describe("refresh", () => {
  test(
    "refreshes from live IMDb and then throttles",
    { tag: "@live-regression" },
    async () => {
      const config = await bootstrapUser(PUBLIC_USER);
      await clearRefreshCooldown(PUBLIC_USER);

      const first = await refresh(PUBLIC_USER);
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(first.body.refreshed).toBe(1);
      expect(first.body.failed).toBe(0);
      expect(first.body.total).toBe(1);
      expect(await countCacheObjects(config.watchlists[0].id)).toBe(2);

      const second = await refresh(PUBLIC_USER);
      expect(second.body.throttled).toBe(true);
    },
  );
});

test.describe("misc endpoints", () => {
  test("health, stats, and configure redirect", { tag: "@local" }, async () => {
    const health = await fetch(`${BACKEND_URL}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { database: string }).database).toBe("up");

    await bootstrapUser(PUBLIC_USER);
    const stats = await fetch(`${BACKEND_URL}/stats`);
    expect(
      ((await stats.json()) as { activeUsers: number }).activeUsers,
    ).toBeGreaterThanOrEqual(1);

    const configure = await fetch(`${BACKEND_URL}/${PUBLIC_USER}/configure`, {
      redirect: "manual",
    });
    expect(configure.status).toBe(302);
    expect(configure.headers.get("location")).toBe(
      `${FRONTEND_URL}/configure?userId=${PUBLIC_USER}`,
    );
  });
});
