import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { StremioMeta, WatchlistData } from "@stremlist/shared";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { getR2Bucket, getR2Client } from "../lib/r2";

const CACHE_FORMAT_VERSION = 1;
const MEMORY_CACHE_TTL_MS = 60_000;
const MEMORY_CACHE_MAX_ENTRIES = 100;

const stremioMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  poster: z.string().nullable(),
  posterShape: z.enum(["poster", "square", "landscape"]),
  type: z.enum(["movie", "series"]),
  genres: z.array(z.string()),
  description: z.string(),
  imdbRating: z.string().optional(),
  releaseInfo: z.string().optional(),
  director: z.array(z.string()).optional(),
  cast: z.array(z.string()).optional(),
  runtime: z.string().optional(),
});

const catalogObjectSchema = z.object({
  version: z.literal(CACHE_FORMAT_VERSION),
  metas: z.array(stremioMetaSchema),
});

const cacheManifestSchema = z.object({
  version: z.literal(CACHE_FORMAT_VERSION),
  generation: z.string().uuid(),
  cachedAt: z.string().datetime(),
  catalogKey: z.string(),
  metaKeys: z.array(z.string()),
});

const deletedManifestSchema = z.object({
  version: z.literal(CACHE_FORMAT_VERSION),
  deleted: z.literal(true),
  deletedAt: z.string().datetime(),
});

const storedManifestSchema = z.union([
  cacheManifestSchema,
  deletedManifestSchema,
]);

type CatalogObject = z.infer<typeof catalogObjectSchema>;
type CacheManifest = z.infer<typeof cacheManifestSchema>;

interface MemoryEntry<T> {
  value: T;
  expiresAt: number;
}

interface ManifestRead {
  manifest: CacheManifest | null;
  etag?: string;
}

export interface CachedWatchlist {
  data: WatchlistData;
  cachedAt: Date;
  generation: string;
}

const manifestMemoryCache = new Map<
  string,
  MemoryEntry<CacheManifest | null>
>();
const catalogMemoryCache = new Map<string, MemoryEntry<CatalogObject>>();

function manifestKey(watchlistId: string): string {
  return `watchlists/${watchlistId}/manifest.json`;
}

function catalogKey(watchlistId: string, generation: string): string {
  return `watchlists/${watchlistId}/generations/${generation}.json.gz`;
}

function metaKey(meta: Pick<StremioMeta, "id" | "type">): string {
  return `${meta.type}:${meta.id}`;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === "PreconditionFailed" ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

function getMemoryValue<T>(
  cache: Map<string, MemoryEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setMemoryValue<T>(
  cache: Map<string, MemoryEntry<T>>,
  key: string,
  value: T,
): void {
  cache.delete(key);
  cache.set(key, {
    value,
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
  });

  while (cache.size > MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

async function readManifestFromR2(watchlistId: string): Promise<ManifestRead> {
  try {
    const response = await getR2Client().send(
      new GetObjectCommand({
        Bucket: getR2Bucket(),
        Key: manifestKey(watchlistId),
      }),
    );
    if (!response.Body) return { manifest: null, etag: response.ETag };

    const parsed: unknown = JSON.parse(await response.Body.transformToString());
    const storedManifest = storedManifestSchema.parse(parsed);
    if ("deleted" in storedManifest) {
      return { manifest: null, etag: response.ETag };
    }

    const manifest = storedManifest;
    if (manifest.catalogKey !== catalogKey(watchlistId, manifest.generation)) {
      throw new Error(`Invalid R2 catalog key for ${watchlistId}`);
    }
    return { manifest, etag: response.ETag };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return { manifest: null };
  }
}

async function readManifest(
  watchlistId: string,
): Promise<CacheManifest | null> {
  const cached = getMemoryValue(manifestMemoryCache, watchlistId);
  if (cached !== undefined) return cached;

  const { manifest } = await readManifestFromR2(watchlistId);
  setMemoryValue(manifestMemoryCache, watchlistId, manifest);
  return manifest;
}

async function readCatalog(
  manifest: CacheManifest,
): Promise<CatalogObject | null> {
  const cached = getMemoryValue(catalogMemoryCache, manifest.catalogKey);
  if (cached) return cached;

  try {
    const response = await getR2Client().send(
      new GetObjectCommand({
        Bucket: getR2Bucket(),
        Key: manifest.catalogKey,
      }),
    );
    if (!response.Body) return null;

    const compressed = Buffer.from(await response.Body.transformToByteArray());
    const parsed: unknown = JSON.parse(gunzipSync(compressed).toString("utf8"));
    const catalog = catalogObjectSchema.parse(parsed);
    setMemoryValue(catalogMemoryCache, manifest.catalogKey, catalog);
    return catalog;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

function uniqueMetas(metas: StremioMeta[]): StremioMeta[] {
  const seen = new Set<string>();
  return metas.filter((meta) => {
    const key = metaKey(meta);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasSortedKey(keys: string[], target: string): boolean {
  let low = 0;
  let high = keys.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = keys[middle];
    if (candidate === target) return true;
    if (candidate < target) low = middle + 1;
    else high = middle - 1;
  }

  return false;
}

export async function getCachedWatchlist(
  watchlistId: string,
): Promise<CachedWatchlist | null> {
  try {
    const manifest = await readManifest(watchlistId);
    if (!manifest) return null;

    const catalog = await readCatalog(manifest);
    if (!catalog || catalog.metas.length === 0) return null;

    return {
      data: { metas: catalog.metas },
      cachedAt: new Date(manifest.cachedAt),
      generation: manifest.generation,
    };
  } catch (error) {
    console.error(`Failed to read R2 cache for ${watchlistId}:`, error);
    return null;
  }
}

export async function writeCachedWatchlist(
  watchlistId: string,
  watchlistData: WatchlistData,
  cachedAt = new Date(),
): Promise<string> {
  const metas = uniqueMetas(watchlistData.metas);
  if (metas.length === 0) {
    await deleteCachedWatchlist(watchlistId);
    return randomUUID();
  }

  const generation = randomUUID();
  const nextCatalogKey = catalogKey(watchlistId, generation);
  const catalog = catalogObjectSchema.parse({
    version: CACHE_FORMAT_VERSION,
    metas,
  });
  const manifest: CacheManifest = {
    version: CACHE_FORMAT_VERSION,
    generation,
    cachedAt: cachedAt.toISOString(),
    catalogKey: nextCatalogKey,
    metaKeys: catalog.metas.map(metaKey).sort(),
  };

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: nextCatalogKey,
      Body: gzipSync(Buffer.from(JSON.stringify(catalog))),
      ContentType: "application/json",
      ContentEncoding: "gzip",
      CacheControl: "private, max-age=0, must-revalidate",
    }),
  );

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: manifestKey(watchlistId),
      Body: Buffer.from(JSON.stringify(manifest)),
      ContentType: "application/json",
      CacheControl: "private, max-age=0, must-revalidate",
    }),
  );

  setMemoryValue(catalogMemoryCache, nextCatalogKey, catalog);
  setMemoryValue(manifestMemoryCache, watchlistId, manifest);

  return generation;
}

export async function findCachedMeta(
  watchlistIds: string[],
  type: string,
  id: string,
): Promise<StremioMeta | null> {
  const target = `${type}:${id}`;
  const manifestResults = await Promise.allSettled(
    watchlistIds.map((watchlistId) => readManifest(watchlistId)),
  );
  const candidates: CacheManifest[] = [];

  manifestResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `Failed to read R2 cache manifest for ${watchlistIds[index]}:`,
        result.reason,
      );
      return;
    }
    if (result.value && hasSortedKey(result.value.metaKeys, target)) {
      candidates.push(result.value);
    }
  });

  for (const manifest of candidates) {
    try {
      const catalog = await readCatalog(manifest);
      const found = catalog?.metas.find(
        (item) => item.type === type && item.id === id,
      );
      if (found) return found;
    } catch (error) {
      console.error("Failed to read an indexed R2 catalog:", error);
    }
  }

  return null;
}

export async function deleteCachedWatchlist(
  watchlistId: string,
): Promise<void> {
  let current: ManifestRead;
  try {
    current = await readManifestFromR2(watchlistId);
  } catch (error) {
    console.error(
      `Failed to read R2 manifest before deleting ${watchlistId}:`,
      error,
    );
    throw error;
  }

  if (!current.manifest) {
    setMemoryValue(manifestMemoryCache, watchlistId, null);
    return;
  }
  if (!current.etag) {
    throw new Error(`R2 manifest for ${watchlistId} is missing an ETag`);
  }

  try {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: manifestKey(watchlistId),
        Body: Buffer.from(
          JSON.stringify({
            version: CACHE_FORMAT_VERSION,
            deleted: true,
            deletedAt: new Date().toISOString(),
          }),
        ),
        ContentType: "application/json",
        CacheControl: "private, max-age=0, must-revalidate",
        IfMatch: current.etag,
      }),
    );
  } catch (error) {
    if (isPreconditionFailed(error)) {
      manifestMemoryCache.delete(watchlistId);
      return;
    }
    throw error;
  }

  setMemoryValue(manifestMemoryCache, watchlistId, null);

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2Bucket(),
      Key: current.manifest.catalogKey,
    }),
  );
  catalogMemoryCache.delete(current.manifest.catalogKey);
}
