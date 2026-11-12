/**
 * The previous watched state of an Account, one R2 object each (ADR 0003).
 * The sweep compares with it, and it stops the trigger and the sweep from
 * sending a title twice. The Watched baseline is its first version.
 */
import { createHash } from "node:crypto";
import {
  deletePrefix,
  isPreconditionFailed,
  readJsonVersion,
  writeJson,
} from "../../lib/r2-json";

/**
 * Which Stremio link a state belongs to: a fingerprint of the sealed key.
 * A read made with another key (an older link) never counts against it.
 */
export function linkOf(sealedKey: string): string {
  return createHash("sha256").update(sealedKey).digest("hex").slice(0, 16);
}

export interface WatchState {
  /** The Stremio link of the Watched baseline (`linkOf`). */
  link?: string;
  /** The newest library `_mtime` that the last saved sweep compared. */
  checkedAt: number;
  savedAt: number;
  /** Movies with timesWatched > 0. */
  movies: string[];
  /**
   * Series ID → what is watched: Stremio's `watched` field as the Watched
   * baseline read it, then, once an episode was sent, every episode ever
   * seen watched ("season:episode"). The list only grows, so an older read
   * or an unmark and remark never sends an episode again.
   */
  series: Record<string, string | string[]>;
}

interface Version {
  state: WatchState | null;
  etag: string | null;
}

function stateKey(accountId: string): string {
  return `watch/${accountId}/state.json`;
}

export async function readState(accountId: string): Promise<Version> {
  const version = await readJsonVersion(stateKey(accountId));
  return {
    state: (version?.value as WatchState | undefined) ?? null,
    etag: version?.etag ?? null,
  };
}

export async function deleteState(accountId: string): Promise<void> {
  await deletePrefix(`watch/${accountId}/`);
}

/**
 * Saves `state` only over the version read (`etag`). Returns false when
 * another run saved first: read again and recompute.
 */
export async function writeState(
  accountId: string,
  state: WatchState,
  etag: string | null,
): Promise<boolean> {
  try {
    await writeJson(stateKey(accountId), state, { etag });
    return true;
  } catch (error) {
    if (isPreconditionFailed(error)) return false;
    throw error;
  }
}
