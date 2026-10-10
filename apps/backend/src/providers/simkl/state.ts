import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2Bucket, getR2Client } from "../../lib/r2";

/** Version of the snapshots below; another version is read again. */
export const STATE_VERSION = 1;

export function libraryKey(accountId: string): string {
  return `connections/${accountId}/simkl/library.json`;
}

export function listKey(accountId: string, listId: string): string {
  return `connections/${accountId}/simkl/lists/${listId}.json`;
}

// Only a fallback when R2 is unreachable: R2 is the shared truth, so an
// instance never trusts an older copy than another instance wrote.
const memoryState = new Map<string, unknown>();

/** Per-Connection state in R2, next to the Action membership. */
export async function readState<T>(key: string): Promise<T | null> {
  try {
    const response = await getR2Client().send(
      new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    );
    if (!response.Body) return null;
    const value = JSON.parse(await response.Body.transformToString()) as T;
    memoryState.set(key, value);
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") return null;
    return (memoryState.get(key) as T | undefined) ?? null;
  }
}

export async function writeState(key: string, value: unknown): Promise<void> {
  memoryState.set(key, value);
  try {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: key,
        Body: Buffer.from(JSON.stringify(value)),
        ContentType: "application/json",
        CacheControl: "private, max-age=0, must-revalidate",
      }),
    );
  } catch (error) {
    console.error(
      `Failed to save Simkl state ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Test hook: forget the in-memory fallback state. */
export function clearMemoryState(): void {
  memoryState.clear();
}
