/**
 * SPIKE: the previous watched state of an Account, one R2 object each
 * (ADR 0003). It is the reference that the sweep compares with, and what
 * stops the trigger and the sweep from sending a Title twice.
 */
import {
  isPreconditionFailed,
  readJsonVersion,
  writeJson,
} from "../../lib/r2-json";

export interface WatchState {
  /** The newest library `_mtime` that the last saved sweep compared. */
  checkedAt: number;
  savedAt: number;
  /** Movies with timesWatched > 0. */
  movies: string[];
  /** Series ID → its `watched` bitfield. */
  series: Record<string, string>;
}

function stateKey(accountId: string): string {
  return `watch/${accountId}/state.json`;
}

export async function readState(
  accountId: string,
): Promise<{ state: WatchState | null; etag: string | null }> {
  const version = await readJsonVersion(stateKey(accountId));
  return {
    state: (version?.value as WatchState | undefined) ?? null,
    etag: version?.etag ?? null,
  };
}

/**
 * Applies `change` to the stored state with a conditional write, again on a
 * lost race. `change` returns false when nothing needs to be written.
 */
export async function updateState(
  accountId: string,
  change: (state: WatchState | null) => WatchState | false,
  first?: { state: WatchState | null; etag: string | null },
): Promise<WatchState | false> {
  let current = first ?? (await readState(accountId));
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = change(current.state);
    if (!next) return false;
    try {
      await writeJson(stateKey(accountId), next, { etag: current.etag });
      return next;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      current = await readState(accountId);
    }
  }
  throw new Error("Watch state stayed busy");
}
