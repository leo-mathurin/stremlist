import { LruCache } from "../../lib/lru";
import type { z } from "zod";
import {
  connectionPrefix,
  readJsonVersion,
  writeJson,
} from "../../lib/r2-json";

/**
 * Version of the snapshots below; another version is read again. Version 2
 * binds a snapshot to its authorization instead of the Simkl username.
 */
export const STATE_VERSION = 2;
/**
 * Version of the library snapshot. Version 3 keeps when each title was
 * rated: older snapshots are read again once, custom lists are not.
 */
export const LIBRARY_VERSION = 3;

export function libraryKey(accountId: string) {
  return `${connectionPrefix(accountId, "simkl")}library.json`;
}

export function playbackKey(accountId: string) {
  return `${connectionPrefix(accountId, "simkl")}playback.json`;
}

export function listKey(accountId: string, listId: string) {
  return `${connectionPrefix(accountId, "simkl")}lists/${listId}.json`;
}

const memoryState = new LruCache<string, unknown>({
  maxEntries: 500,
  maxWeight: 8 * 1024 * 1024,
  ttlMs: 30 * 60_000,
});

/**
 * Per-Connection state in R2, next to the Action membership. State that does
 * not match `schema` (an older version) is null: it is read again.
 */
export async function readState<T>(key: string, schema: z.ZodType<T>) {
  let stored: unknown;
  try {
    stored = (await readJsonVersion(key))?.value;
  } catch {
    stored = memoryState.get(key);
  }
  if (stored == null) return null;
  const parsed = schema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export async function writeState(key: string, value: unknown) {
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
export function forgetMemoryState(accountId: string) {
  const prefix = connectionPrefix(accountId, "simkl");
  for (const key of memoryState.keys()) {
    if (key.startsWith(prefix)) memoryState.delete(key);
  }
}

/** Test hook: forget the in-memory fallback state. */
export function clearMemoryState() {
  memoryState.clear();
}
