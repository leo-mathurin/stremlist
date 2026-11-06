import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  readJsonVersion,
  writeJson,
  isPreconditionFailed,
} from "../lib/r2-json";
import { letterboxdSnapshotSchema } from "./letterboxd-page";
import { SourceUnavailableError } from "./types";

const HTTP_KEY = "providers/letterboxd/http-v1.json";
const httpStateSchema = z.object({
  activeId: z.string().nullable(),
  activeUntil: z.number(),
  nextAt: z.number(),
  pausedUntil: z.number(),
  halted: z.boolean(),
  failures: z.number().int().nonnegative(),
});
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
/** Letterboxd refused Stremlist: the Provider is unavailable until an operator resets the halt. */
const halted = () =>
  new SourceUnavailableError(
    "disabled",
    "Letterboxd is temporarily unavailable",
  );

/**
 * Tell Better Stack once, when this instance flips the shared state to halted.
 * Best effort: a missing URL or a failed ping never affects the read.
 */
async function notifyHalted(reason: string) {
  const heartbeat = process.env.BETTERSTACK_HEARTBEAT_URL_LETTERBOXD;
  if (!heartbeat) return;
  try {
    await fetch(`${heartbeat}/fail`, {
      method: "POST",
      body: `Letterboxd halted: ${reason}`,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error(
      "Reporting the Letterboxd halt failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Whether Letterboxd reads are halted (shared R2 state). Unreadable state counts as not halted. */
export async function isLetterboxdHalted(): Promise<boolean> {
  try {
    const stored = await readJsonVersion(HTTP_KEY);
    return stored ? httpStateSchema.parse(stored.value).halted : false;
  } catch {
    return false;
  }
}
export const LETTERBOXD_FRESHNESS_MS = 6 * 60 * 60_000;

async function readState<T>(key: string, schema: z.ZodType<T>, initial: T) {
  const stored = await readJsonVersion(key);
  if (stored && !stored.etag) throw unavailable();
  return {
    value: stored ? schema.parse(stored.value) : initial,
    etag: stored?.etag ?? null,
  };
}

/** R2 conditional writes coordinate every Vercel instance; failure denies new sends. */
export async function withLetterboxdPermit<T>(
  read: () => Promise<{
    value: T;
    result: "ok" | "blocked" | "failed";
    retryAfterMs?: number;
  }>,
): Promise<T> {
  const id = randomUUID();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const now = Date.now();
    const state = await readState(HTTP_KEY, httpStateSchema, {
      activeId: null,
      activeUntil: 0,
      nextAt: 0,
      pausedUntil: 0,
      halted: false,
      failures: 0,
    });
    if (state.value.halted) throw halted();
    if (state.value.pausedUntil > now) throw unavailable();
    if (state.value.activeId && state.value.activeUntil <= now) {
      try {
        await writeJson(
          HTTP_KEY,
          { ...state.value, halted: true },
          { etag: state.etag },
        );
        await notifyHalted(
          "an HTTP reservation expired with an unknown result",
        );
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
      }
      throw halted();
    }
    if (now >= deadline) throw unavailable();
    if (state.value.activeId || state.value.nextAt > now) {
      await sleep(Math.min(500, Math.max(100, state.value.nextAt - now)));
      continue;
    }
    try {
      await writeJson(
        HTTP_KEY,
        { ...state.value, activeId: id, activeUntil: now + 45_000 },
        { etag: state.etag },
      );
      if (Date.now() >= now + 45_000) throw unavailable();
      break;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
  }
  async function finish(
    result: "ok" | "blocked" | "failed",
    retryAfterMs: number,
  ) {
    const state = await readState(HTTP_KEY, httpStateSchema, {
      activeId: null,
      activeUntil: 0,
      nextAt: 0,
      pausedUntil: 0,
      halted: true,
      failures: 0,
    });
    if (state.value.activeId !== id) throw unavailable();
    const failures = result === "failed" ? state.value.failures + 1 : 0;
    const nextHalted =
      state.value.halted || result === "blocked" || failures >= 3;
    await writeJson(
      HTTP_KEY,
      {
        activeId: null,
        activeUntil: 0,
        nextAt: Date.now() + 3000,
        pausedUntil:
          result === "failed"
            ? Date.now() + Math.max(15 * 60_000, retryAfterMs)
            : 0,
        halted: nextHalted,
        failures,
      },
      { etag: state.etag },
    );
    // Edge-triggered: only the instance whose write flips the shared flag reports.
    if (!state.value.halted && nextHalted)
      await notifyHalted(
        result === "blocked"
          ? "Letterboxd refused a request (403, 429 or a challenge)"
          : "three consecutive reads failed",
      );
  }
  let result: "ok" | "blocked" | "failed" = "failed";
  let retryAfterMs = 0;
  try {
    const response = await read();
    result = response.result;
    retryAfterMs = response.retryAfterMs ?? 0;
    return response.value;
  } finally {
    await finish(result, retryAfterMs);
  }
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
