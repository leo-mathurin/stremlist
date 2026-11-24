import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { z } from "zod";
import { scheduleBackgroundTask } from "../lib/background";
import { mapWithConcurrency } from "../lib/concurrency";
import { isTmdbConfigured, tmdbGet } from "./tmdb";

/** When a movie came out to stream or buy, as the list cache keeps it. */
export interface DigitalRelease {
  /** The first digital or physical release in any country, per TMDB. */
  digitalReleased?: string;
  /** When TMDB was last asked. Absent: never asked, so nothing is known. */
  digitalCheckedAt?: string;
}

const DAY_MS = 24 * 60 * 60_000;
const RECENT_MS = 365 * DAY_MS;
const RECHECK_MS = DAY_MS;
const MAX_LOOKUPS = 50;
const LOOKUP_BUDGET_MS = 5_000;
const CONCURRENCY = 6;
const MEMORY_MAX_ENTRIES = 5000;
const DIGITAL_OR_PHYSICAL_RELEASE_TYPES = new Set([4, 5]);

const memory = new Map<
  string,
  Required<Pick<DigitalRelease, "digitalCheckedAt">> & DigitalRelease
>();

/**
 * Whether a movie is recent enough to wait for its digital release: out in
 * cinemas less than a year ago, in the future, or with no date and this
 * year's or a later year.
 */
export function isRecentMovie(meta: StremioMeta, now = Date.now()) {
  if (meta.type !== "movie") return false;
  const released = Date.parse(meta.released ?? "");
  if (Number.isFinite(released)) return released > now - RECENT_MS;
  const year = Number.parseInt(meta.releaseInfo ?? "", 10);
  return year >= new Date(now).getUTCFullYear();
}

/**
 * Whether a recent movie is not out to stream or buy yet. A movie TMDB was
 * never asked about does not wait: the cinema release date decides alone.
 */
export function awaitsDigitalRelease(
  meta: StremioMeta & DigitalRelease,
  now = Date.now(),
) {
  if (!meta.digitalCheckedAt || !isRecentMovie(meta, now)) return false;
  const released = Date.parse(meta.digitalReleased ?? "");
  return !(Number.isFinite(released) && released <= now);
}

function needsCheck(meta: DigitalRelease, now: number) {
  const checked = Date.parse(meta.digitalCheckedAt ?? "");
  if (!Number.isFinite(checked)) return true;
  const released = Date.parse(meta.digitalReleased ?? "");
  if (Number.isFinite(released) && released <= now) return false;
  return now - checked >= RECHECK_MS;
}

const releaseDatesSchema = z.object({
  results: z
    .array(
      z.object({
        release_dates: z
          .array(z.object({ type: z.number(), release_date: z.string() }))
          .nullish(),
      }),
    )
    .nullish(),
});

/**
 * The first digital or physical release of a movie in any country, by its
 * IMDb ID, or null when TMDB knows none. Throws when TMDB fails.
 */
export async function fetchDigitalRelease(imdbId: string) {
  const data = await tmdbGet(
    `/movie/${imdbId}/release_dates`,
    releaseDatesSchema,
  );
  let first = Number.POSITIVE_INFINITY;
  for (const country of data?.results ?? []) {
    for (const release of country.release_dates ?? []) {
      if (!DIGITAL_OR_PHYSICAL_RELEASE_TYPES.has(release.type)) continue;
      const time = Date.parse(release.release_date);
      if (Number.isFinite(time) && time < first) first = time;
    }
  }
  return Number.isFinite(first) ? new Date(first).toISOString() : null;
}

function remember(imdbId: string, release: DigitalRelease) {
  if (!release.digitalCheckedAt) return;
  memory.delete(imdbId);
  memory.set(imdbId, {
    ...release,
    digitalCheckedAt: release.digitalCheckedAt,
  });
  while (memory.size > MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (!oldest) break;
    memory.delete(oldest);
  }
}

function digitalReleaseOf(meta: DigitalRelease) {
  return {
    ...(meta.digitalReleased ? { digitalReleased: meta.digitalReleased } : {}),
    ...(meta.digitalCheckedAt
      ? { digitalCheckedAt: meta.digitalCheckedAt }
      : {}),
  };
}

/**
 * The metas with the digital release date of each recent movie, from the
 * previous cache generation, memory, or TMDB. Up to the cap, unchecked movies
 * are asked about first, then the oldest checks. A movie still to come out in
 * cinemas is not asked about: the cinema rule already hides it. Lookups get
 * at most `budgetMs`; the rest go on in the background for the next read.
 */
export async function withDigitalReleases<
  T extends StremioMeta & DigitalRelease,
>(
  metas: T[],
  previous: (id: string) => DigitalRelease | undefined,
  now = Date.now(),
  budgetMs = LOOKUP_BUDGET_MS,
) {
  const found = new Map<string, DigitalRelease>();
  const missing = new Map<string, string>();
  for (const meta of metas) {
    if (!isRecentMovie(meta, now) || found.has(meta.id)) continue;
    const candidates = [memory.get(meta.id), previous(meta.id), meta].filter(
      (value): value is DigitalRelease => !!value?.digitalCheckedAt,
    );
    const latest = candidates.sort((a, b) =>
      (b.digitalCheckedAt ?? "").localeCompare(a.digitalCheckedAt ?? ""),
    )[0];
    if (latest) found.set(meta.id, digitalReleaseOf(latest));
    const inCinemasLater = Date.parse(meta.released ?? "") > now;
    if (!inCinemasLater && (!latest || needsCheck(latest, now))) {
      missing.set(meta.id, latest?.digitalCheckedAt ?? "");
    }
  }

  if (missing.size > 0 && isTmdbConfigured()) {
    const ids = [...missing]
      .sort(([, a], [, b]) => a.localeCompare(b))
      .slice(0, MAX_LOOKUPS)
      .map(([id]) => id);
    const work = mapWithConcurrency(ids, CONCURRENCY, async (id) => {
      try {
        const released = await fetchDigitalRelease(id);
        const release = {
          ...(released ? { digitalReleased: released } : {}),
          digitalCheckedAt: new Date(now).toISOString(),
        };
        found.set(id, release);
        remember(id, release);
      } catch (error) {
        console.error(
          `TMDB digital release lookup failed for ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
    clearTimeout(timer);
    scheduleBackgroundTask(() => work);
  }

  if (found.size === 0) return metas;
  return metas.map((meta) => {
    const release = found.get(meta.id);
    if (!release || !isRecentMovie(meta, now)) return meta;
    const copy = { ...meta };
    delete copy.digitalReleased;
    delete copy.digitalCheckedAt;
    return { ...copy, ...release };
  });
}

/** Forget the in-memory lookups (tests). */
export function forgetDigitalReleases() {
  memory.clear();
}
