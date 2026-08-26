import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { StremioMeta } from "@stremlist/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

function requiredKey(key: string | undefined): string {
  if (!key) throw new Error("R2 test command is missing a key");
  return key;
}

const r2 = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  failGetContaining: null as string | null,
  failPutContaining: null as string | null,
  beforeConditionalPut: null as (() => void) | null,
  afterConditionalPut: null as (() => Promise<void>) | null,
  send: vi.fn((command: unknown) => Promise.resolve(command)),
}));

function etagFor(body: Uint8Array): string {
  return `"${Buffer.from(body).toString("base64")}"`;
}

function storedObject(
  objects: Map<string, Uint8Array>,
  key: string,
): Uint8Array {
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
    if (afterConditionalPut) {
      return afterConditionalPut().then(() => ({}));
    }
    return {};
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
  deleteCachedWatchlist,
  findCachedMeta,
  getCachedWatchlist,
  writeCachedWatchlist,
} from "../watchlist-cache";

const MOVIE: StremioMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: "https://example.com/poster.jpg",
  posterShape: "poster",
  genres: ["Drama"],
  description: "A film.",
};

let sequence = 0;
function watchlistId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeEach(() => {
  r2.objects.clear();
  r2.failGetContaining = null;
  r2.failPutContaining = null;
  r2.beforeConditionalPut = null;
  r2.afterConditionalPut = null;
  r2.send.mockClear();
});

describe("R2 watchlist cache", () => {
  it("round-trips a compressed catalog and de-duplicates repeated items", async () => {
    const id = watchlistId();
    const cachedAt = new Date("2026-08-26T10:00:00.000Z");

    await writeCachedWatchlist(id, { metas: [MOVIE, { ...MOVIE }] }, cachedAt);

    const cached = await getCachedWatchlist(id);
    expect(cached?.data).toEqual({ metas: [MOVIE] });
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

  it("finds a meta in a cached watchlist and keeps types separate", async () => {
    const id = watchlistId();
    const series: StremioMeta = { ...MOVIE, type: "series", name: "Series" };
    await writeCachedWatchlist(id, { metas: [MOVIE, series] });

    expect(await findCachedMeta([id], "movie", MOVIE.id)).toEqual(MOVIE);
    expect(await findCachedMeta([id], "series", MOVIE.id)).toEqual(series);
    expect(await findCachedMeta([id], "movie", "tt9999999")).toBeNull();
  });

  it("uses the manifest index to avoid reading catalog blobs on a meta miss", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    for (let index = 0; index <= 100; index += 1) {
      await writeCachedWatchlist(watchlistId(), { metas: [MOVIE] });
    }
    r2.send.mockClear();

    expect(await findCachedMeta([id], "movie", "tt9999999")).toBeNull();
    expect(r2.send).toHaveBeenCalledTimes(1);
    const command = r2.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input.Key).toMatch(/manifest\.json$/u);
  });

  it("treats R2 read failures as cache misses", async () => {
    const id = watchlistId();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    r2.failGetContaining = "manifest.json";

    expect(await getCachedWatchlist(id)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to read R2 cache for ${id}:`,
      expect.any(Error),
    );
  });

  it("keeps the previous object when an overwrite fails", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    r2.failPutContaining = "/generations/";

    await expect(
      writeCachedWatchlist(id, {
        metas: [{ ...MOVIE, id: "tt0068646", name: "The Godfather" }],
      }),
    ).rejects.toThrow("simulated R2 write failure");

    r2.failPutContaining = null;
    expect((await getCachedWatchlist(id))?.data.metas).toEqual([MOVIE]);
  });

  it("keeps the previous manifest when the atomic switch fails", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    r2.failPutContaining = "manifest.json";

    await expect(
      writeCachedWatchlist(id, {
        metas: [{ ...MOVIE, id: "tt0068646", name: "The Godfather" }],
      }),
    ).rejects.toThrow("simulated R2 write failure");

    r2.failPutContaining = null;
    expect((await getCachedWatchlist(id))?.data.metas).toEqual([MOVIE]);
    // The unreferenced generation is left for the lifecycle rule. Deleting it
    // after a network error would be unsafe because the manifest PUT may have
    // committed even when the client did not receive the response.
    expect(r2.objects.size).toBe(3);
  });

  it("keeps the previous generation readable after replacement", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    const previousCatalogKey = [...r2.objects.keys()].find((key) =>
      key.includes("/generations/"),
    );
    if (!previousCatalogKey) throw new Error("Missing previous generation");

    await writeCachedWatchlist(id, {
      metas: [{ ...MOVIE, id: "tt0068646", name: "The Godfather" }],
    });

    expect(r2.objects.has(previousCatalogKey)).toBe(true);
    expect(r2.objects.size).toBe(3);
  });

  it("does not delete a concurrently replaced manifest", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    const previousObjects = new Map(r2.objects);

    const replacement = {
      ...MOVIE,
      id: "tt0068646",
      name: "The Godfather",
    };
    await writeCachedWatchlist(id, { metas: [replacement] });
    const replacementObjects = new Map(r2.objects);
    const currentManifestKey = [...replacementObjects.keys()].find((key) =>
      key.endsWith("/manifest.json"),
    );
    const replacementCatalogKey = [...replacementObjects.keys()].find(
      (key) => key.includes("/generations/") && !previousObjects.has(key),
    );
    if (!currentManifestKey || !replacementCatalogKey) {
      throw new Error("Missing replacement R2 test objects");
    }

    r2.objects.clear();
    previousObjects.forEach((body, key) => r2.objects.set(key, body));
    r2.beforeConditionalPut = () => {
      r2.objects.set(
        currentManifestKey,
        storedObject(replacementObjects, currentManifestKey),
      );
      r2.objects.set(
        replacementCatalogKey,
        storedObject(replacementObjects, replacementCatalogKey),
      );
    };

    await deleteCachedWatchlist(id);

    expect((await getCachedWatchlist(id))?.data.metas).toEqual([replacement]);
    expect(r2.objects.has(replacementCatalogKey)).toBe(true);
  });

  it("keeps a local replacement cached when it follows the tombstone", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    const replacement = {
      ...MOVIE,
      id: "tt0068646",
      name: "The Godfather",
    };
    r2.afterConditionalPut = () =>
      writeCachedWatchlist(id, { metas: [replacement] }).then(() => undefined);

    await deleteCachedWatchlist(id);
    r2.failGetContaining = "manifest.json";

    expect((await getCachedWatchlist(id))?.data.metas).toEqual([replacement]);
  });

  it("refreshes a stale manifest when its generation is missing", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });
    const staleObjects = new Map(r2.objects);

    r2.objects.clear();
    const replacement = {
      ...MOVIE,
      id: "tt0068646",
      name: "The Godfather",
    };
    await writeCachedWatchlist(id, { metas: [replacement] });
    const replacementObjects = new Map(r2.objects);

    for (let index = 0; index <= 100; index += 1) {
      await writeCachedWatchlist(watchlistId(), { metas: [MOVIE] });
    }

    r2.objects.clear();
    staleObjects.forEach((body, key) => r2.objects.set(key, body));
    expect(await findCachedMeta([id], "movie", "tt9999999")).toBeNull();

    r2.objects.clear();
    replacementObjects.forEach((body, key) => r2.objects.set(key, body));

    expect((await getCachedWatchlist(id))?.data.metas).toEqual([replacement]);
  });

  it("invalidates the cache and deletes its current catalog", async () => {
    const id = watchlistId();
    await writeCachedWatchlist(id, { metas: [MOVIE] });

    await deleteCachedWatchlist(id);

    expect(await getCachedWatchlist(id)).toBeNull();
    expect(
      [...r2.objects.keys()].filter((key) =>
        key.startsWith(`watchlists/${id}/`),
      ),
    ).toEqual([`watchlists/${id}/manifest.json`]);
  });
});
