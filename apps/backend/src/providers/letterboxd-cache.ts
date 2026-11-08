import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  readJsonVersion,
  writeJson,
  isPreconditionFailed,
} from "../lib/r2-json";
import { letterboxdSnapshotSchema } from "./letterboxd-page";
import { SourceUnavailableError } from "./types";

const cacheSchema = z.object({
  fetchedAt: z.number(),
  leaseId: z.string().nullable(),
  leaseUntil: z.number(),
  snapshot: letterboxdSnapshotSchema.nullable(),
});
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const unavailable = () =>
  new SourceUnavailableError(
    "unavailable",
    "Letterboxd is temporarily unavailable",
  );

export const LETTERBOXD_FRESHNESS_MS = 6 * 60 * 60_000;

async function readState<T>(key: string, schema: z.ZodType<T>, initial: T) {
  const stored = await readJsonVersion(key);
  if (stored && !stored.etag) throw unavailable();
  return {
    value: stored ? schema.parse(stored.value) : initial,
    etag: stored?.etag ?? null,
  };
}

/** Anonymous snapshots can be shared by Accounts. The lease prevents duplicate pagination. */
export async function letterboxdSnapshot(
  key: string,
  read: () => Promise<z.infer<typeof letterboxdSnapshotSchema>>,
  forceRefresh = false,
) {
  const requestedAt = Date.now();
  const id = randomUUID();
  const deadline = Date.now() + 10_000;
  let state: Awaited<ReturnType<typeof load>>;
  async function load() {
    return readState(key, cacheSchema, {
      fetchedAt: 0,
      leaseId: null,
      leaseUntil: 0,
      snapshot: null,
    });
  }
  for (;;) {
    state = await load();
    if (
      state.value.snapshot &&
      Date.now() - state.value.fetchedAt < LETTERBOXD_FRESHNESS_MS &&
      (!forceRefresh || state.value.fetchedAt >= requestedAt)
    )
      return state.value.snapshot;
    if (state.value.leaseUntil > Date.now()) {
      if (state.value.snapshot && !forceRefresh) return state.value.snapshot;
      if (Date.now() >= deadline) throw unavailable();
      await sleep(500);
      continue;
    }
    try {
      await writeJson(
        key,
        { ...state.value, leaseId: id, leaseUntil: Date.now() + 10 * 60_000 },
        { etag: state.etag },
      );
      state = await load();
      if (state.value.leaseId !== id) throw unavailable();
      break;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
  }
  try {
    const snapshot = letterboxdSnapshotSchema.parse(await read());
    await writeJson(
      key,
      { fetchedAt: Date.now(), leaseId: null, leaseUntil: 0, snapshot },
      { etag: state.etag },
    );
    return snapshot;
  } catch (error) {
    // A 404 is definitive: the list is gone, turned private, or its Share link
    // was revoked. Drop the snapshot so its Titles cannot be served again. Any
    // other failure is transient and keeps the last good snapshot.
    const gone =
      error instanceof SourceUnavailableError && error.reason === "not_found";
    try {
      await writeJson(
        key,
        {
          ...state.value,
          snapshot: gone ? null : state.value.snapshot,
          leaseId: null,
          leaseUntil: 0,
        },
        { etag: state.etag },
      );
    } catch {
      /* The lease expires if storage is unavailable or another writer owns it. */
    }
    throw error;
  }
}
