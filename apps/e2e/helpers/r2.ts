import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
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

export async function countCacheObjects(watchlistId: string): Promise<number> {
  return (await listKeys(`watchlists/${watchlistId}/`)).length;
}

export async function deleteCacheObjects(
  watchlistIds: string[],
): Promise<void> {
  const keys = (
    await Promise.all(
      [...new Set(watchlistIds)].map((watchlistId) =>
        listKeys(`watchlists/${watchlistId}/`),
      ),
    )
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
