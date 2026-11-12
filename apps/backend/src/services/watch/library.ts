/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- SPIKE code */
/**
 * SPIKE (spike/watch-tracking-load): the reads of Watch tracking on
 * Stremio's library (ADR 0003), with call counters for the load test.
 */
import { inflateSync } from "node:zlib";
import { LruCache } from "../../lib/lru";
import { STREMIO_API } from "../stremio";

export interface LibraryItem {
  _id: string;
  type: string;
  _mtime?: string | number;
  state?: {
    timeWatched?: number;
    duration?: number;
    timesWatched?: number;
    video_id?: string;
    watched?: string;
    lastWatched?: string;
  };
}

class LibraryReadError extends Error {}

const TIMEOUT_MS = 10_000;

export const libraryStats = {
  get: 0,
  meta: 0,
  failed: 0,
  latencies: [] as number[],
  metaBytes: 0,
  cinemeta: 0,
};

async function call<T>(method: string, body: object, via?: string): Promise<T> {
  const started = performance.now();
  try {
    const response = await fetch(`${STREMIO_API}/${method}`, {
      method: "POST",
      // SPIKE: tells the mock which reads come from the sweep.
      headers: {
        "content-type": "application/json",
        ...(via ? { "x-spike-via": via } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (method === "datastoreMeta") libraryStats.metaBytes += text.length;
    if (!response.ok) throw new LibraryReadError(`HTTP ${response.status}`);
    const answer = JSON.parse(text) as { result?: T; error?: unknown };
    if (answer.result === undefined) throw new LibraryReadError("no result");
    return answer.result;
  } catch (error) {
    libraryStats.failed += 1;
    throw error instanceof LibraryReadError
      ? error
      : new LibraryReadError(error instanceof Error ? error.message : "error");
  } finally {
    libraryStats.latencies.push(performance.now() - started);
  }
}

export async function datastoreGet(
  authKey: string,
  ids: string[],
  via?: "sweep",
): Promise<LibraryItem[]> {
  libraryStats.get += 1;
  return call<LibraryItem[]>(
    "datastoreGet",
    { authKey, collection: "libraryItem", ids, all: false },
    via,
  );
}

/** Every item of the library as [id, mtime]. */
export async function datastoreMeta(
  authKey: string,
): Promise<[string, number][]> {
  libraryStats.meta += 1;
  return call<[string, number][]>("datastoreMeta", {
    authKey,
    collection: "libraryItem",
  });
}

export function mtimeOf(item: LibraryItem): number {
  const value = item._mtime;
  if (typeof value === "number") return value;
  return value ? Date.parse(value) : 0;
}

/**
 * The set bits of a `watched` bitfield, `{anchor}:{length}:{base64(zlib)}`
 * (the anchor of an episode has colons too).
 */
export function watchedBits(field: string | undefined): Set<number> {
  const bits = new Set<number>();
  if (!field) return bits;
  const encoded = field.slice(field.lastIndexOf(":") + 1);
  let bytes: Buffer;
  try {
    bytes = inflateSync(Buffer.from(encoded, "base64"));
  } catch {
    return bits;
  }
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) if (bytes[i] & (1 << b)) bits.add(i * 8 + b);
  }
  return bits;
}

const CINEMETA =
  process.env.CINEMETA_URL?.trim() || "https://v3-cinemeta.strem.io";
const videoLists = new LruCache<string, { season: number; episode: number }[]>({
  maxEntries: 5000,
  ttlMs: 6 * 3600_000,
});

/** The episodes of a series in Stremio's bitfield order. */
export async function seriesVideos(
  imdbId: string,
): Promise<{ season: number; episode: number }[]> {
  const cached = videoLists.get(imdbId);
  if (cached) return cached;
  libraryStats.cinemeta += 1;
  const response = await fetch(`${CINEMETA}/meta/series/${imdbId}.json`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new LibraryReadError(`Cinemeta ${response.status}`);
  const body = (await response.json()) as {
    meta?: {
      videos?: { season: number; episode: number; released?: string }[];
    };
  };
  const videos = (body.meta?.videos ?? [])
    .map(({ season, episode, released }) => ({ season, episode, released }))
    .sort(
      (a, b) =>
        a.season - b.season ||
        a.episode - b.episode ||
        String(a.released).localeCompare(String(b.released)),
    )
    .map(({ season, episode }) => ({ season, episode }));
  videoLists.set(imdbId, videos);
  return videos;
}
