import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { ProviderId } from "@stremlist/shared/providers";
import { getR2Bucket, getR2Client } from "./r2";

/** Whether an R2 error means that the object does not exist. */
export function isNotFound(error: unknown): boolean {
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

/**
 * Where a Connection keeps its objects (Action membership, Provider sync
 * state). A disconnect deletes everything under it.
 */
export function connectionPrefix(
  accountId: string,
  provider: ProviderId,
): string {
  return `connections/${accountId}/${provider}/`;
}

/** A JSON object, or null when it does not exist. Other errors throw. */
export async function readJson<T>(key: string): Promise<T | null> {
  try {
    const response = await getR2Client().send(
      new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    );
    if (!response.Body) return null;
    return JSON.parse(await response.Body.transformToString()) as T;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Store a private JSON object that is never cached on the way. */
export async function writeJson(key: string, value: unknown): Promise<void> {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: key,
      Body: Buffer.from(JSON.stringify(value)),
      ContentType: "application/json",
      CacheControl: "private, max-age=0, must-revalidate",
    }),
  );
}

/** Delete every object whose key starts with `prefix`, page by page. */
export async function deletePrefix(prefix: string): Promise<void> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (page.Contents ?? []).flatMap((object) =>
      object.Key ? [{ Key: object.Key }] : [],
    );
    // A list page holds at most 1,000 keys, the most one delete accepts.
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
}
