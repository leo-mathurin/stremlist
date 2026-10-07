import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
} from "../env.js";

const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchBucket" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export async function ensureR2Bucket(): Promise<void> {
  try {
    await r2.send(new HeadBucketCommand({ Bucket: R2_BUCKET }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await r2.send(new CreateBucketCommand({ Bucket: R2_BUCKET }));
  }
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await r2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(
      ...(response.Contents ?? []).flatMap((object) =>
        object.Key ? [object.Key] : [],
      ),
    );
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return keys;
}

/**
 * The cache key of one Source list of a merged List, as the backend derives
 * it (apps/backend/src/services/merged-lists.ts). A List with one Source list
 * uses its List ID instead.
 */
export function sourceCacheKey(
  listId: string,
  source: { provider: string; sourceRef: string },
): string {
  const digest = createHash("sha256")
    .update(`${source.provider}:${source.sourceRef}`)
    .digest("hex")
    .slice(0, 16);
  return `${listId}/sources/${digest}`;
}

export async function countCacheObjects(listId: string): Promise<number> {
  return (await listKeys(`watchlists/${listId}/`)).length;
}

// R2 keys keep the historical "watchlists/" prefix for List caches.
export async function getCacheObjectKeys(listId: string): Promise<string[]> {
  return listKeys(`watchlists/${listId}/`);
}

export async function getConnectionObjectKeys(
  accountId: string,
): Promise<string[]> {
  return listKeys(`connections/${accountId}/`);
}

export async function getCacheManifest(listId: string): Promise<unknown> {
  const response = await r2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: `watchlists/${listId}/manifest.json`,
    }),
  );
  if (!response.Body) throw new Error("R2 cache manifest has no body");
  return JSON.parse(await response.Body.transformToString());
}

async function deletePrefixes(prefixes: string[]): Promise<void> {
  const keys = (
    await Promise.all([...new Set(prefixes)].map((prefix) => listKeys(prefix)))
  ).flat();

  for (let index = 0; index < keys.length; index += 1_000) {
    await r2.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: {
          Objects: keys.slice(index, index + 1_000).map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
}

/** Remove every cached Catalog generation of these Lists. */
export async function deleteCacheObjects(listIds: string[]): Promise<void> {
  await deletePrefixes(listIds.map((listId) => `watchlists/${listId}/`));
}

/** Remove what Actions stored for these Accounts' Connections. */
export async function deleteConnectionObjects(
  accountIds: string[],
): Promise<void> {
  await deletePrefixes(
    accountIds.map((accountId) => `connections/${accountId}/`),
  );
}

/** Write controlled input in the on-disk format consumed by the real backend. */
export async function seedCachedCatalog(
  id: string,
  metas: StremioMeta[],
): Promise<void> {
  const generation = randomUUID();
  const catalogKey = `watchlists/${id}/generations/${generation}.json.gz`;
  const genres = (type: StremioMeta["type"]) =>
    [
      ...new Set(
        metas
          .filter((meta) => meta.type === type)
          .flatMap((meta) => meta.genres),
      ),
    ].sort();
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: catalogKey,
      Body: gzipSync(JSON.stringify({ version: 1, metas })),
      ContentType: "application/json",
      ContentEncoding: "gzip",
    }),
  );
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `watchlists/${id}/manifest.json`,
      Body: JSON.stringify({
        version: 1,
        generation,
        cachedAt: new Date().toISOString(),
        catalogKey,
        metaKeys: metas.map((meta) => `${meta.type}:${meta.id}`).sort(),
        genres: { movie: genres("movie"), series: genres("series") },
      }),
      ContentType: "application/json",
    }),
  );
}
