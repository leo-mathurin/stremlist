import { LruCache } from "../../lib/lru";
import { connectionPrefix, readJson, writeJson } from "../../lib/r2-json";

/** Version of the snapshots below; another version is read again. */
export const STATE_VERSION = 1;

export function libraryKey(accountId: string): string {
  return `${connectionPrefix(accountId, "simkl")}library.json`;
}

export function listKey(accountId: string, listId: string): string {
  return `${connectionPrefix(accountId, "simkl")}lists/${listId}.json`;
}

// Only a fallback when R2 is unreachable: R2 is the shared truth, so an
// instance never trusts an older copy than another instance wrote. It keeps
// what this instance wrote: a sync result that R2 refused is not lost, and an
// outage does not make the instance read a whole library again. Copies read
// from R2 are not kept: they would only duplicate R2, at up to ~1.6 MB each.
// 8 MB holds about five of the largest libraries and many more usual ones;
// after 30 minutes a copy is dropped, and the next sync writes a new one.
const memoryState = new LruCache<string, unknown>({
  maxEntries: 500,
  maxWeight: 8 * 1024 * 1024,
  ttlMs: 30 * 60_000,
});

/** Per-Connection state in R2, next to the Action membership. */
export async function readState<T>(key: string): Promise<T | null> {
  try {
    return await readJson<T>(key);
  } catch {
    return (memoryState.get(key) as T | undefined) ?? null;
  }
}

export async function writeState(key: string, value: unknown): Promise<void> {
  memoryState.set(key, value, { weight: JSON.stringify(value).length });
  try {
    await writeJson(key, value);
  } catch (error) {
    console.error(
      `Failed to save Simkl state ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** After a disconnect: forget the fallback copies of one Account's state. */
export function forgetMemoryState(accountId: string): void {
  const prefix = connectionPrefix(accountId, "simkl");
  for (const key of memoryState.keys()) {
    if (key.startsWith(prefix)) memoryState.delete(key);
  }
}

/** Test hook: forget the in-memory fallback state. */
export function clearMemoryState(): void {
  memoryState.clear();
}
