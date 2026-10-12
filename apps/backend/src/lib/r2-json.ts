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

/** Whether an R2 error means that a conditional write lost a race. */
export function isPreconditionFailed(error: unknown): boolean {
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

/**
 * A JSON object with its ETag, for a conditional write later (see
 * `writeJson`). Null when it does not exist. Other errors throw.
 */
export async function readJsonVersion(
  key: string,
): Promise<{ value: unknown; etag: string | undefined } | null> {
  try {
    const response = await getR2Client().send(
      new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    );
    if (!response.Body) return null;
    return {
      value: JSON.parse(await response.Body.transformToString()) as unknown,
      etag: response.ETag,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Store a private JSON object that is never cached on the way. With
 * `expected`, the write happens only while the object is still that version
 * (its ETag), or still missing (null); otherwise it throws an error that
 * `isPreconditionFailed` recognizes.
 */
export async function writeJson(
  key: string,
  value: unknown,
  expected?: { etag: string | null },
): Promise<void> {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: key,
      Body: Buffer.from(JSON.stringify(value)),
      ContentType: "application/json",
      CacheControl: "private, max-age=0, must-revalidate",
      ...(expected
        ? expected.etag === null
          ? { IfNoneMatch: "*" }
          : { IfMatch: expected.etag }
        : {}),
    }),
  );
}

/** Delete a prefix page by page, optionally retaining a nested prefix. */
export async function deletePrefix(
  prefix: string,
  retainedPrefix?: string,
): Promise<void> {
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
      object.Key && (!retainedPrefix || !object.Key.startsWith(retainedPrefix))
        ? [{ Key: object.Key }]
        : [],
    );
    // A list page holds at most 1,000 keys, the most one delete accepts.
    if (keys.length > 0) {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      // A bulk delete succeeds even when some objects stay; it lists them.
      if (result.Errors?.length) {
        throw new Error(
          `Could not delete ${result.Errors.length} objects under ${prefix}`,
        );
      }
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
}
