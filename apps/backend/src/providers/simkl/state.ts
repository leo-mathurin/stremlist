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
// instance never trusts an older copy than another instance wrote.
const memoryState = new Map<string, unknown>();

/** Per-Connection state in R2, next to the Action membership. */
export async function readState<T>(key: string): Promise<T | null> {
  try {
    const value = await readJson<T>(key);
    if (value !== null) memoryState.set(key, value);
    return value;
  } catch {
    return (memoryState.get(key) as T | undefined) ?? null;
  }
}

export async function writeState(key: string, value: unknown): Promise<void> {
  memoryState.set(key, value);
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
  for (const key of [...memoryState.keys()]) {
    if (key.startsWith(prefix)) memoryState.delete(key);
  }
}

/** Test hook: forget the in-memory fallback state. */
export function clearMemoryState(): void {
  memoryState.clear();
}
