import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { getR2Bucket, getR2Client } from "../lib/r2";
import { isNotFound, writeJson } from "../lib/r2-json";

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
  released: z.string().datetime().optional(),
  // When the Title joined the Source list; never served to Stremio.
  addedAt: z.string().datetime().optional(),
});

/**
 * A Title as the cache keeps it: its meta, and when it joined its Source
 * list (ADR 0006). The date is never served to Stremio.
 */
export type SourceMeta = StremioMeta & { addedAt?: string };

/** The canonical Catalog of one Source list, as the cache keeps it. */
export interface SourceCatalogData {
  metas: SourceMeta[];
}

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
  // The Source list the catalog was read from. A List that now points to
  // another source must not serve it. Older generations have none.
  source: z.string().optional(),
  // Older cache generations acquire summaries on their next refresh.
  genres: z
    .object({ movie: z.array(z.string()), series: z.array(z.string()) })
    .optional(),
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

interface CatalogRead {
  manifest: CacheManifest;
  catalog: CatalogObject;
}

/** The Source list a cached catalog was read from. */
export interface CacheSource {
  provider: string;
  sourceRef: string;
}

function sourceKey(source: CacheSource): string {
  return `${source.provider}:${source.sourceRef}`;
}

/** Whether a manifest may serve a List that now reads from `source`. */
function servesSource(manifest: CacheManifest, source?: CacheSource): boolean {
  return (
    !source ||
    manifest.source === undefined ||
    manifest.source === sourceKey(source)
  );
}

interface CachedList {
  data: SourceCatalogData;
  cachedAt: Date;
  generation: string;
}

const manifestMemoryCache = new Map<
  string,
  MemoryEntry<CacheManifest | null>
>();
const catalogMemoryCache = new Map<string, MemoryEntry<CatalogObject>>();

// R2 keys keep the "watchlists/" prefix so caches written before Lists had
// several Providers stay readable.
function manifestKey(listId: string): string {
  return `watchlists/${listId}/manifest.json`;
}

function catalogKey(listId: string, generation: string): string {
  return `watchlists/${listId}/generations/${generation}.json.gz`;
}

function metaKey(meta: Pick<StremioMeta, "id" | "type">): string {
  return `${meta.type}:${meta.id}`;
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

function cacheDeletedManifest(listId: string, deletedGeneration: string): void {
  const entry = manifestMemoryCache.get(listId);
  if (entry?.value && entry.value.generation !== deletedGeneration) return;
  setMemoryValue(manifestMemoryCache, listId, null);
}

function evictManifestGeneration(
  listId: string,
  staleGeneration: string,
): void {
  const entry = manifestMemoryCache.get(listId);
  if (entry?.value && entry.value.generation !== staleGeneration) return;
  manifestMemoryCache.delete(listId);
}

async function readManifestFromR2(listId: string): Promise<ManifestRead> {
  try {
    const response = await getR2Client().send(
      new GetObjectCommand({
        Bucket: getR2Bucket(),
        Key: manifestKey(listId),
      }),
    );
    if (!response.Body) return { manifest: null, etag: response.ETag };

    const parsed: unknown = JSON.parse(await response.Body.transformToString());
    const storedManifest = storedManifestSchema.parse(parsed);
    if ("deleted" in storedManifest) {
      return { manifest: null, etag: response.ETag };
    }

    const manifest = storedManifest;
    if (manifest.catalogKey !== catalogKey(listId, manifest.generation)) {
      throw new Error(`Invalid R2 catalog key for ${listId}`);
    }
    return { manifest, etag: response.ETag };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return { manifest: null };
  }
}

async function readManifest(listId: string): Promise<CacheManifest | null> {
  const cached = getMemoryValue(manifestMemoryCache, listId);
  if (cached !== undefined) return cached;

  const entryBeforeRead = manifestMemoryCache.get(listId);
  const { manifest } = await readManifestFromR2(listId);
  const concurrentEntry = manifestMemoryCache.get(listId);
  if (concurrentEntry !== entryBeforeRead) {
    const concurrentValue = getMemoryValue(manifestMemoryCache, listId);
    if (concurrentValue !== undefined) return concurrentValue;
  }
  setMemoryValue(manifestMemoryCache, listId, manifest);
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

async function readCatalogWithManifestRefresh(
  listId: string,
  manifest: CacheManifest,
): Promise<CatalogRead | null> {
  const catalog = await readCatalog(manifest);
  if (catalog) return { manifest, catalog };

  evictManifestGeneration(listId, manifest.generation);
  const refreshedManifest = await readManifest(listId);
  if (
    !refreshedManifest ||
    refreshedManifest.generation === manifest.generation
  ) {
    return null;
  }

  const refreshedCatalog = await readCatalog(refreshedManifest);
  if (!refreshedCatalog) return null;
  return { manifest: refreshedManifest, catalog: refreshedCatalog };
}

function collectGenres(
  metas: StremioMeta[],
  type: StremioMeta["type"],
): string[] {
  return [
    ...new Set(
      metas
        .filter((meta) => meta.type === type)
        .flatMap((meta) => meta.genres)
        .filter((genre) => genre.trim().length > 0),
    ),
  ].sort();
}

function uniqueMetas(metas: SourceMeta[]): SourceMeta[] {
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

export async function getCachedListSummary(
  listId: string,
  source?: CacheSource,
): Promise<{ movie: string[]; series: string[] } | null> {
  try {
    const manifest = await readManifest(listId);
    if (!manifest || !servesSource(manifest, source)) return null;
    return manifest.genres ?? null;
  } catch (error) {
    console.error(`Failed to read R2 cache summary for ${listId}:`, error);
    return null;
  }
}

/**
 * When the cached Catalog of a List was written and how many Titles it has,
 * from the manifest only. Null when nothing is cached or the cache was marked
 * stale.
 */
export async function getCachedListInfo(
  listId: string,
  source?: CacheSource,
): Promise<{ cachedAt: string; titleCount: number } | null> {
  try {
    const manifest = await readManifest(listId);
    if (
      !manifest ||
      !servesSource(manifest, source) ||
      new Date(manifest.cachedAt).getTime() <= 0
    ) {
      return null;
    }
    return {
      cachedAt: manifest.cachedAt,
      titleCount: manifest.metaKeys.length,
    };
  } catch (error) {
    console.error(`Failed to read R2 cache info for ${listId}:`, error);
    return null;
  }
}

/**
 * The cached catalog of a List. With `source`, a catalog read from another
 * Source list (the List was edited since) is a miss.
 */
export async function getCachedList(
  listId: string,
  source?: CacheSource,
): Promise<CachedList | null> {
  try {
    const manifest = await readManifest(listId);
    if (!manifest) return null;

    const current = await readCatalogWithManifestRefresh(listId, manifest);
    if (
      !current ||
      current.catalog.metas.length === 0 ||
      !servesSource(current.manifest, source)
    ) {
      return null;
    }

    return {
      data: { metas: current.catalog.metas },
      cachedAt: new Date(current.manifest.cachedAt),
      generation: current.manifest.generation,
    };
  } catch (error) {
    console.error(`Failed to read R2 cache for ${listId}:`, error);
    return null;
  }
}

export async function writeCachedList(
  listId: string,
  listData: SourceCatalogData,
  cachedAt = new Date(),
  source?: CacheSource,
): Promise<string> {
  const metas = uniqueMetas(listData.metas);
  if (metas.length === 0) {
    await deleteCachedList(listId);
    return randomUUID();
  }

  const generation = randomUUID();
  const nextCatalogKey = catalogKey(listId, generation);
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
    ...(source ? { source: sourceKey(source) } : {}),
    genres: {
      movie: collectGenres(catalog.metas, "movie"),
      series: collectGenres(catalog.metas, "series"),
    },
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

  await writeJson(manifestKey(listId), manifest);

  setMemoryValue(catalogMemoryCache, nextCatalogKey, catalog);
  setMemoryValue(manifestMemoryCache, listId, manifest);

  return generation;
}

export async function findCachedMeta(
  listId: string,
  type: string,
  id: string,
): Promise<SourceMeta | null> {
  const target = `${type}:${id}`;
  try {
    const manifest = await readManifest(listId);
    if (!manifest || !hasSortedKey(manifest.metaKeys, target)) return null;
    const current = await readCatalogWithManifestRefresh(listId, manifest);
    if (!current || !hasSortedKey(current.manifest.metaKeys, target)) {
      return null;
    }
    return (
      current.catalog.metas.find(
        (item) => item.type === type && item.id === id,
      ) ?? null
    );
  } catch (error) {
    console.error(`Failed to read the R2 cache of ${listId}:`, error);
    return null;
  }
}

export async function deleteCachedList(listId: string): Promise<void> {
  let current: ManifestRead;
  try {
    current = await readManifestFromR2(listId);
  } catch (error) {
    console.error(
      `Failed to read R2 manifest before deleting ${listId}:`,
      error,
    );
    throw error;
  }

  if (!current.manifest) {
    setMemoryValue(manifestMemoryCache, listId, null);
    return;
  }
  if (!current.etag) {
    throw new Error(`R2 manifest for ${listId} is missing an ETag`);
  }

  try {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: manifestKey(listId),
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
      return;
    }
    throw error;
  }

  cacheDeletedManifest(listId, current.manifest.generation);

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2Bucket(),
      Key: current.manifest.catalogKey,
    }),
  );
  catalogMemoryCache.delete(current.manifest.catalogKey);
}

/**
 * Make the next catalog request refetch this List (after an Action changed
 * it on the Provider), while keeping the cached items as a fallback.
 */
export async function markCachedListStale(listId: string): Promise<void> {
  const manifest = await readManifest(listId);
  if (!manifest) return;
  const stale: CacheManifest = {
    ...manifest,
    cachedAt: new Date(0).toISOString(),
  };
  await writeJson(manifestKey(listId), stale);
  setMemoryValue(manifestMemoryCache, listId, stale);
}
