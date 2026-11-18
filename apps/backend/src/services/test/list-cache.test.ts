import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  seedAccount,
  seedConnection,
} from "../../test/helpers/account.fixture";
import { db } from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import {
  putR2Bytes,
  r2Bytes,
  r2Objects,
  r2Puts,
  r2Unreadable,
  r2Unwritable,
  resetR2,
} from "../../test/helpers/r2.test-utils";
import { encryptSecret } from "../../lib/crypto";
import { getConnectionAccess, saveConnection } from "../connections";
import {
  deleteCachedList,
  findCachedMeta,
  forgetMemoryCache,
  getCachedList,
  getCachedListSummary,
  writeCachedList,
} from "../list-cache";

const BUCKET = "http://r2.test/test-bucket";
const server = useMswServer();

interface SentRequest {
  method: string;
  key: string;
}

const sent: SentRequest[] = [];

server.events.on("request:start", ({ request }) => {
  if (!request.url.startsWith(`${BUCKET}/`)) return;
  sent.push({
    method: request.method,
    key: decodeURIComponent(new URL(request.url).pathname).slice(
      "/test-bucket/".length,
    ),
  });
});

function requiredKey(key: string | undefined) {
  if (!key) throw new Error("R2 test is missing a key");
  return key;
}

function manifestKeyOf(id: string) {
  return `watchlists/${id}/manifest.json`;
}

function keysContaining(text: string) {
  return [...r2Objects.keys()].filter((key) => key.includes(text));
}

function snapshot() {
  return new Map(
    [...r2Objects.keys()].map((key) => [key, r2Bytes(key) ?? Buffer.alloc(0)]),
  );
}

function restore(objects: Map<string, Buffer>) {
  r2Objects.clear();
  for (const [key, bytes] of objects) putR2Bytes(key, bytes);
}

function etagOf(bytes: Buffer) {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function afterNextManifestWrite(id: string, then: () => Promise<void>) {
  const key = manifestKeyOf(id);
  server.use(
    http.put(
      `${BUCKET}/${key}`,
      async ({ request }) => {
        const current = r2Bytes(key);
        if (
          current === undefined ||
          etagOf(current) !== request.headers.get("If-Match")
        ) {
          return new HttpResponse(null, { status: 412 });
        }
        const bytes = Buffer.from(await request.arrayBuffer());
        putR2Bytes(key, bytes);
        await then();
        return new HttpResponse(null, {
          status: 200,
          headers: { ETag: etagOf(bytes) },
        });
      },
      { once: true },
    ),
  );
}

const MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: "https://example.com/poster.jpg",
  posterShape: "poster",
  genres: ["Drama"],
  description: "A film.",
};

const GODFATHER = { ...MOVIE, id: "tt0068646", name: "The Godfather" };
const DRAMA_SUMMARY = { movie: ["Drama"], series: [] };
const TRAKT_WATCHLIST = { provider: "trakt", sourceRef: "me/watchlist" };

let sequence = 0;
function watchlistId() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function expectOnlyManifestRead(id: string) {
  expect(sent).toEqual([{ method: "GET", key: manifestKeyOf(id) }]);
}

beforeEach(() => {
  resetR2();
  forgetMemoryCache();
  sent.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  resetR2();
});

describe("R2 watchlist cache", () => {
  it("round-trips a compressed catalog and de-duplicates repeated items", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = watchlistId();
    const cachedAt = new Date("2026-08-26T10:00:00.000Z");

    const meta = { ...MOVIE, enrichedAt: "2026-08-20T00:00:00.000Z" };
    await writeCachedList(id, { metas: [meta, { ...meta }] }, cachedAt);
    vi.setSystemTime(Date.now() + 61_000);
    const cached = await getCachedList(id);
    expect(cached?.data).toEqual({ metas: [meta] });
    expect(cached?.cachedAt).toEqual(cachedAt);
    expect(cached?.generation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(r2Objects.size).toBe(2);
    expect([...r2Objects.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/manifest\.json$/u),
        expect.stringMatching(/generations\/.+\.json\.gz$/u),
      ]),
    );
  });

  it("reads sorted per-type genres from a cold manifest without loading the catalog", async () => {
    const id = watchlistId();
    await writeCachedList(id, {
      metas: [
        { ...MOVIE, genres: ["Drama", "Action", "Drama", "", "  "] },
        { ...MOVIE, type: "series", genres: ["Comedy", "Drama"] },
      ],
    });
    forgetMemoryCache();
    sent.length = 0;
    for (const key of keysContaining("/generations/")) r2Unreadable.add(key);

    expect(await getCachedListSummary(id)).toEqual({
      movie: ["Action", "Drama"],
      series: ["Comedy", "Drama"],
    });
    expectOnlyManifestRead(id);
  });

  it("keeps legacy catalogs readable and adds their summary on refresh", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const key = `watchlists/${id}/manifest.json`;
    const manifest = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(r2Objects.get(key) ?? ""));
    delete manifest.genres;
    r2Objects.set(key, JSON.stringify(manifest));
    forgetMemoryCache();
    sent.length = 0;
    expect(await getCachedListSummary(id)).toBeNull();
    expect(sent).toHaveLength(1);
    expect((await getCachedList(id))?.data.metas).toEqual([MOVIE]);
    await writeCachedList(id, { metas: [MOVIE] });
    expect(await getCachedListSummary(id)).toEqual(DRAMA_SUMMARY);
  });

  it("returns no summary for missing, deleted, or unreadable manifests", async () => {
    expect(await getCachedListSummary(watchlistId())).toBeNull();
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    await deleteCachedList(id);
    expect(await getCachedListSummary(id)).toBeNull();
    const unreadable = watchlistId();
    r2Unreadable.add(manifestKeyOf(unreadable));
    const errorSpy = vi.spyOn(console, "error");
    expect(await getCachedListSummary(unreadable)).toBeNull();
    errorSpy.mockRestore();
  });

  it("finds a meta in a cached watchlist and keeps types separate", async () => {
    const id = watchlistId();
    const series: StremioMeta = { ...MOVIE, type: "series", name: "Series" };
    await writeCachedList(id, { metas: [MOVIE, series] });

    expect(await findCachedMeta(id, "movie", MOVIE.id)).toEqual(MOVIE);
    expect(await findCachedMeta(id, "series", MOVIE.id)).toEqual(series);
    expect(await findCachedMeta(id, "movie", "tt9999999")).toBeNull();
  });

  it("uses the manifest index to avoid reading catalog blobs on a meta miss", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    forgetMemoryCache();
    sent.length = 0;

    expect(await findCachedMeta(id, "movie", "tt9999999")).toBeNull();
    expectOnlyManifestRead(id);
  });

  it("treats R2 read failures as cache misses", async () => {
    const id = watchlistId();
    const errorSpy = vi.spyOn(console, "error");
    r2Unreadable.add(manifestKeyOf(id));

    expect(await getCachedList(id)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to read R2 cache for ${id}:`,
      expect.any(Error),
    );
  });

  it("keeps the previous object when an overwrite fails", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    r2Unwritable.add(`watchlists/${id}/generations/`);

    await expect(writeCachedList(id, { metas: [GODFATHER] })).rejects.toThrow(
      "AccessDenied",
    );

    r2Unwritable.clear();
    expect((await getCachedList(id))?.data.metas).toEqual([MOVIE]);
  });

  it("keeps the previous manifest when the atomic switch fails", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    r2Unwritable.add(manifestKeyOf(id));

    await expect(writeCachedList(id, { metas: [GODFATHER] })).rejects.toThrow(
      "AccessDenied",
    );

    r2Unwritable.clear();
    expect((await getCachedList(id))?.data.metas).toEqual([MOVIE]);
    expect(r2Objects.size).toBe(3);
    expect(await getCachedListSummary(id)).toEqual(DRAMA_SUMMARY);
  });

  it("keeps the previous generation readable after replacement", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const previousCatalogKey = [...r2Objects.keys()].find((key) =>
      key.includes("/generations/"),
    );

    await writeCachedList(id, { metas: [GODFATHER] });

    expect(previousCatalogKey).toBeDefined();
    expect(r2Objects.has(requiredKey(previousCatalogKey))).toBe(true);
    expect(r2Objects.size).toBe(3);
  });

  it("does not delete a concurrently replaced manifest", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const previousObjects = snapshot();
    await writeCachedList(id, { metas: [GODFATHER] });
    const replacementObjects = snapshot();
    const replaced = [...replacementObjects.keys()].filter(
      (key) =>
        key.endsWith("/manifest.json") ||
        (key.includes("/generations/") && !previousObjects.has(key)),
    );
    expect(replaced).toHaveLength(2);

    restore(previousObjects);
    forgetMemoryCache();
    r2Puts.before = (key) => {
      if (key !== manifestKeyOf(id)) return;
      r2Puts.before = null;
      for (const replacedKey of replaced) {
        const bytes = replacementObjects.get(replacedKey);
        if (bytes) putR2Bytes(replacedKey, bytes);
      }
    };

    await deleteCachedList(id);

    expect((await getCachedList(id))?.data.metas).toEqual([GODFATHER]);
    expect(r2Objects.size).toBe(3);
  });

  it("keeps a local replacement cached when it follows the tombstone", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    afterNextManifestWrite(id, () =>
      writeCachedList(id, { metas: [GODFATHER] }).then(() => undefined),
    );

    await deleteCachedList(id);
    r2Unreadable.add(manifestKeyOf(id));

    expect((await getCachedList(id))?.data.metas).toEqual([GODFATHER]);
  });

  it("refreshes a stale manifest when its generation is missing", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const staleObjects = snapshot();

    r2Objects.clear();
    await writeCachedList(id, { metas: [GODFATHER] });
    const replacementObjects = snapshot();
    forgetMemoryCache();

    restore(staleObjects);
    expect(await findCachedMeta(id, "movie", "tt9999999")).toBeNull();

    restore(replacementObjects);
    expect((await getCachedList(id))?.data.metas).toEqual([GODFATHER]);
  });

  it("misses for a List that now reads another Source list", async () => {
    const id = watchlistId();
    const top = { provider: "imdb", sourceRef: "imdb:top-rated-movies" };
    const popular = { provider: "imdb", sourceRef: "imdb:most-popular-movies" };
    await writeCachedList(id, { metas: [MOVIE] }, new Date(), top);

    expect((await getCachedList(id, top))?.data.metas).toEqual([MOVIE]);
    expect(await getCachedList(id, popular)).toBeNull();
    expect(await getCachedListSummary(id, popular)).toBeNull();
    expect(await getCachedListSummary(id, top)).toEqual(DRAMA_SUMMARY);
  });

  it("serves a cache written without a source to any Source list", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });

    expect(
      (await getCachedList(id, { provider: "imdb", sourceRef: "ls1" }))?.data
        .metas,
    ).toEqual([MOVIE]);
  });

  it("invalidates the cache and deletes its current catalog", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });

    await deleteCachedList(id);

    expect(await getCachedList(id)).toBeNull();
    expect(
      [...r2Objects.keys()].filter((key) =>
        key.startsWith(`watchlists/${id}/`),
      ),
    ).toEqual([`watchlists/${id}/manifest.json`]);
  });
});

describe("private cache ownership", () => {
  async function writePrivate() {
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    const connection = await getConnectionAccess(account.id, "trakt");
    if (!connection) throw new Error("Expected seeded Connection");
    const id = watchlistId();
    const write = () =>
      writeCachedList(
        id,
        { metas: [MOVIE] },
        new Date(),
        TRAKT_WATCHLIST,
        connection.identity,
      );
    await write();
    return { accountId: account.id, id, write };
  }

  it("rejects every cached view after disconnect, even with warm memory", async () => {
    const { id } = await writePrivate();
    expect((await getCachedList(id, TRAKT_WATCHLIST))?.data.metas).toEqual([
      MOVIE,
    ]);
    db.getTable("connections").splice(0);
    expect(await getCachedList(id, TRAKT_WATCHLIST)).toBeNull();
    expect(await getCachedListSummary(id, TRAKT_WATCHLIST)).toBeNull();
    expect(
      await findCachedMeta(id, "movie", MOVIE.id, TRAKT_WATCHLIST),
    ).toBeNull();
  });

  it("keeps private cached fallback when only the access token rotates", async () => {
    const { id } = await writePrivate();
    const connection = db.getTable("connections").at(0);
    if (!connection) throw new Error("Expected seeded Connection");
    connection.access_token = encryptSecret("refreshed-token");

    expect((await getCachedList(id, TRAKT_WATCHLIST))?.data.metas).toEqual([
      MOVIE,
    ]);
    expect(await getCachedListSummary(id, TRAKT_WATCHLIST)).not.toBeNull();
    expect(
      await findCachedMeta(id, "movie", MOVIE.id, TRAKT_WATCHLIST),
    ).toEqual(MOVIE);
  });

  it("does not reuse private data from an older authorization", async () => {
    const { accountId, id, write } = await writePrivate();
    await saveConnection(
      accountId,
      "trakt",
      {
        accessToken: "replacement",
        refreshToken: null,
        expiresAt: null,
        scope: null,
      },
      "another-user",
      "https://example.test/callback",
    );
    expect(await getCachedList(id, TRAKT_WATCHLIST)).toBeNull();
    await write();
    expect(
      await findCachedMeta(id, "movie", MOVIE.id, TRAKT_WATCHLIST),
    ).toBeNull();
  });

  it("rebuilds legacy private caches that have no authorization identity", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] }, new Date(), TRAKT_WATCHLIST);
    expect(await getCachedList(id, TRAKT_WATCHLIST)).toBeNull();
    expect(
      await findCachedMeta(id, "movie", MOVIE.id, TRAKT_WATCHLIST),
    ).toBeNull();
  });
});
