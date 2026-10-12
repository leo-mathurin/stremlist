import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock(
  "../../lib/supabase",
  () => import("../../__tests__/helpers/mock-supabase"),
);
import { seedAccount, seedConnection } from "../../__tests__/helpers/fixtures";
import { db } from "../../__tests__/helpers/mock-supabase";
import { encryptSecret } from "../../lib/crypto";
import { getConnectionAccess, saveConnection } from "../connections";

const r2 = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  failGetContaining: null as string | null,
  failPutContaining: null as string | null,
  beforeConditionalPut: null as (() => void) | null,
  afterConditionalPut: null as (() => Promise<void>) | null,
  send: vi.fn<(command: unknown) => Promise<unknown>>(),
}));

function requiredKey(key: string | undefined): string {
  if (!key) throw new Error("R2 test command is missing a key");
  return key;
}

function etagFor(body: Uint8Array): string {
  return `"${Buffer.from(body).toString("base64")}"`;
}

function stored(objects: Map<string, Uint8Array>, key: string): Uint8Array {
  const body = objects.get(key);
  if (!body) throw new Error(`Missing R2 test object: ${key}`);
  return body;
}

function handleCommand(command: unknown): unknown {
  if (command instanceof PutObjectCommand) {
    const key = requiredKey(command.input.Key);
    let afterConditionalPut: (() => Promise<void>) | null = null;
    if (r2.failPutContaining && key.includes(r2.failPutContaining)) {
      throw new Error("simulated R2 write failure");
    }
    if (!(command.input.Body instanceof Uint8Array)) {
      throw new Error("R2 test expects a Uint8Array body");
    }
    if (command.input.IfMatch) {
      const beforeConditionalPut = r2.beforeConditionalPut;
      r2.beforeConditionalPut = null;
      afterConditionalPut = r2.afterConditionalPut;
      r2.afterConditionalPut = null;
      beforeConditionalPut?.();
      const current = r2.objects.get(key);
      if (!current || etagFor(current) !== command.input.IfMatch) {
        throw Object.assign(new Error("precondition failed"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
    }
    r2.objects.set(key, Uint8Array.from(command.input.Body));
    return afterConditionalPut ? afterConditionalPut().then(() => ({})) : {};
  }

  if (command instanceof GetObjectCommand) {
    const key = requiredKey(command.input.Key);
    if (r2.failGetContaining && key.includes(r2.failGetContaining)) {
      throw new Error("simulated R2 read failure");
    }
    const body = r2.objects.get(key);
    if (!body) {
      throw Object.assign(new Error("missing"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    }
    return {
      ETag: etagFor(body),
      Body: {
        transformToByteArray: () => Promise.resolve(body),
        transformToString: () =>
          Promise.resolve(Buffer.from(body).toString("utf8")),
      },
    };
  }

  if (command instanceof DeleteObjectCommand) {
    r2.objects.delete(requiredKey(command.input.Key));
    return {};
  }

  throw new Error("Unsupported R2 command");
}

r2.send.mockImplementation((command: unknown) =>
  Promise.resolve(handleCommand(command)),
);

vi.mock("../../lib/r2", () => ({
  getR2Bucket: () => "test-bucket",
  getR2Client: () => ({ send: r2.send }),
}));

import {
  deleteCachedList,
  findCachedMeta,
  getCachedList,
  getCachedListSummary,
  writeCachedList,
} from "../list-cache";

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
function watchlistId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/** Writes more Lists than the process caches hold, so reads go to R2. */
async function evictMemoryCaches(): Promise<void> {
  for (let index = 0; index <= 100; index += 1) {
    await writeCachedList(watchlistId(), { metas: [MOVIE] });
  }
}

function expectOnlyManifestRead(id: string): void {
  expect(r2.send).toHaveBeenCalledTimes(1);
  const command = r2.send.mock.calls[0][0];
  expect(command).toBeInstanceOf(GetObjectCommand);
  expect((command as GetObjectCommand).input.Key).toBe(
    `watchlists/${id}/manifest.json`,
  );
}

beforeEach(() => {
  r2.objects.clear();
  r2.failGetContaining = null;
  r2.failPutContaining = null;
  r2.beforeConditionalPut = null;
  r2.afterConditionalPut = null;
  r2.send.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("R2 watchlist cache", () => {
  it("round-trips a compressed catalog and de-duplicates repeated items", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = watchlistId();
    const cachedAt = new Date("2026-08-26T10:00:00.000Z");

    const meta = { ...MOVIE, enrichedAt: "2026-08-20T00:00:00.000Z" };
    await writeCachedList(id, { metas: [meta, { ...meta }] }, cachedAt);
    // Drop the process caches: enrichment time must survive persisted JSON.
    vi.setSystemTime(Date.now() + 61_000);
    const cached = await getCachedList(id);
    expect(cached?.data).toEqual({ metas: [meta] });
    expect(cached?.cachedAt).toEqual(cachedAt);
    expect(cached?.generation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(r2.objects.size).toBe(2);
    expect([...r2.objects.keys()]).toEqual(
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
    await evictMemoryCaches();
    r2.send.mockClear();
    r2.failGetContaining = "/generations/";

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
      .record(z.unknown())
      .parse(JSON.parse(Buffer.from(stored(r2.objects, key)).toString()));
    delete manifest.genres;
    r2.objects.set(key, Buffer.from(JSON.stringify(manifest)));
    await evictMemoryCaches();
    r2.send.mockClear();
    expect(await getCachedListSummary(id)).toBeNull();
    expect(r2.send).toHaveBeenCalledTimes(1);
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
    r2.failGetContaining = "manifest.json";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getCachedListSummary(watchlistId())).toBeNull();
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
    await evictMemoryCaches();
    r2.send.mockClear();

    expect(await findCachedMeta(id, "movie", "tt9999999")).toBeNull();
    expectOnlyManifestRead(id);
  });

  it("treats R2 read failures as cache misses", async () => {
    const id = watchlistId();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    r2.failGetContaining = "manifest.json";

    expect(await getCachedList(id)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to read R2 cache for ${id}:`,
      expect.any(Error),
    );
  });

  it("keeps the previous object when an overwrite fails", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    r2.failPutContaining = "/generations/";

    await expect(writeCachedList(id, { metas: [GODFATHER] })).rejects.toThrow(
      "simulated R2 write failure",
    );

    r2.failPutContaining = null;
    expect((await getCachedList(id))?.data.metas).toEqual([MOVIE]);
  });

  it("keeps the previous manifest when the atomic switch fails", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    r2.failPutContaining = "manifest.json";

    await expect(writeCachedList(id, { metas: [GODFATHER] })).rejects.toThrow(
      "simulated R2 write failure",
    );

    r2.failPutContaining = null;
    expect((await getCachedList(id))?.data.metas).toEqual([MOVIE]);
    // The unreferenced generation is left for the lifecycle rule. Deleting it
    // after a network error would be unsafe because the manifest PUT may have
    // committed even when the client did not receive the response.
    expect(r2.objects.size).toBe(3);
    expect(await getCachedListSummary(id)).toEqual(DRAMA_SUMMARY);
  });

  it("keeps the previous generation readable after replacement", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const previousCatalogKey = [...r2.objects.keys()].find((key) =>
      key.includes("/generations/"),
    );

    await writeCachedList(id, { metas: [GODFATHER] });

    expect(previousCatalogKey).toBeDefined();
    expect(r2.objects.has(requiredKey(previousCatalogKey))).toBe(true);
    expect(r2.objects.size).toBe(3);
  });

  it("does not delete a concurrently replaced manifest", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const previousObjects = new Map(r2.objects);
    await writeCachedList(id, { metas: [GODFATHER] });
    const replacementObjects = new Map(r2.objects);
    const replaced = [...replacementObjects.keys()].filter(
      (key) =>
        key.endsWith("/manifest.json") ||
        (key.includes("/generations/") && !previousObjects.has(key)),
    );
    expect(replaced).toHaveLength(2);

    r2.objects = new Map(previousObjects);
    r2.beforeConditionalPut = () => {
      for (const key of replaced) {
        r2.objects.set(key, stored(replacementObjects, key));
      }
    };

    await deleteCachedList(id);

    expect((await getCachedList(id))?.data.metas).toEqual([GODFATHER]);
    expect(r2.objects.size).toBe(3);
  });

  it("keeps a local replacement cached when it follows the tombstone", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    r2.afterConditionalPut = () =>
      writeCachedList(id, { metas: [GODFATHER] }).then(() => undefined);

    await deleteCachedList(id);
    r2.failGetContaining = "manifest.json";

    expect((await getCachedList(id))?.data.metas).toEqual([GODFATHER]);
  });

  it("refreshes a stale manifest when its generation is missing", async () => {
    const id = watchlistId();
    await writeCachedList(id, { metas: [MOVIE] });
    const staleObjects = new Map(r2.objects);

    r2.objects.clear();
    await writeCachedList(id, { metas: [GODFATHER] });
    const replacementObjects = new Map(r2.objects);
    await evictMemoryCaches();

    r2.objects = new Map(staleObjects);
    expect(await findCachedMeta(id, "movie", "tt9999999")).toBeNull();

    r2.objects = new Map(replacementObjects);
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
      [...r2.objects.keys()].filter((key) =>
        key.startsWith(`watchlists/${id}/`),
      ),
    ).toEqual([`watchlists/${id}/manifest.json`]);
  });
});

describe("private cache ownership", () => {
  /** Writes MOVIE as read through a new Trakt Connection of a new Account. */
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
    // A late old writer is equally unreadable.
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
