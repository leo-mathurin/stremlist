import { z } from "zod";
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
export function linkOf(sealedKey: string) {
  return createHash("sha256").update(sealedKey).digest("hex").slice(0, 16);
}

const watchStateSchema = z.object({
  link: z.string().optional(),
  checkedAt: z.number(),
  savedAt: z.number(),
  movies: z.array(z.string()),
  series: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});
export type WatchState = z.infer<typeof watchStateSchema>;

interface Version {
  state: WatchState | null;
  etag: string | null;
}

function stateKey(accountId: string) {
  return `watch/${accountId}/state.json`;
}

export async function readState(accountId: string) {
  const version = await readJsonVersion(stateKey(accountId));
  return {
    state:
      version?.value == null ? null : watchStateSchema.parse(version.value),
    etag: version?.etag ?? null,
  };
}

export async function deleteState(accountId: string) {
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
) {
  try {
    await writeJson(stateKey(accountId), state, { etag });
    return true;
  } catch (error) {
    if (isPreconditionFailed(error)) return false;
    throw error;
  }
}
