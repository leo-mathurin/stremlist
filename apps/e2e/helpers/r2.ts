import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ListSource } from "@stremlist/shared/list-merge";
import { sourceKey } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
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
export function sourceCacheKey(listId: string, source: ListSource): string {
  const digest = createHash("sha256")
    .update(sourceKey(source))
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

/**
 * Remove what these Accounts' Connections stored (Actions, Provider state,
 * Connection-only detection history) and their other detection history.
 */
export async function deleteConnectionObjects(
  accountIds: string[],
): Promise<void> {
  await deletePrefixes(
    accountIds.flatMap((accountId) => [
      `connections/${accountId}/`,
      `history/${accountId}/`,
    ]),
  );
}

/**
 * The detection history of one Source list (ADR 0008), in the format of
 * apps/backend/src/services/title-history.ts.
 */
export interface StoredHistory {
  version: 1;
  source: string;
  baselineAt: string;
  lastSyncAt: string;
  connection: { user: string | null; connectedAt: string } | null;
  /** Entry key → [IMDb ID, detection date, removal date]. */
  entries: Record<string, [string | null, string | null, string | null]>;
}

/** Where the backend keeps the history of a Source list. */
export function historyObjectKey(
  accountId: string,
  source: { provider: ProviderId; sourceRef: string },
): string {
  const digest = createHash("sha256")
    .update(sourceKey(source))
    .digest("hex")
    .slice(0, 16);
  return sourceRequiresConnection(source.provider, source.sourceRef)
    ? `connections/${accountId}/${source.provider}/history/${digest}.json`
    : `history/${accountId}/${digest}.json`;
}

export async function writeHistoryObject(
  key: string,
  history: StoredHistory,
): Promise<void> {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: JSON.stringify(history),
      ContentType: "application/json",
    }),
  );
}

/** Every stored detection history of an Account. */
export async function readHistoryObjects(
  accountId: string,
): Promise<StoredHistory[]> {
  const keys = (
    await Promise.all([
      listKeys(`history/${accountId}/`),
      listKeys(`connections/${accountId}/`),
    ])
  )
    .flat()
    .filter((key) => key.startsWith("history/") || key.includes("/history/"));
  return Promise.all(
    keys.map(async (Key) => {
      const response = await r2.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key }),
      );
      if (!response.Body) throw new Error(`R2 history ${Key} has no body`);
      return JSON.parse(
        await response.Body.transformToString(),
      ) as StoredHistory;
    }),
  );
}

/** Write controlled input in the on-disk format consumed by the real backend. */
export async function seedCachedCatalog(
  id: string,
  metas: StremioMeta[],
  connection?: {
    accountId: string;
    provider: ProviderId;
    authorization: string;
  },
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
        connection,
        metaKeys: metas.map((meta) => `${meta.type}:${meta.id}`).sort(),
        genres: { movie: genres("movie"), series: genres("series") },
      }),
      ContentType: "application/json",
    }),
  );
}
