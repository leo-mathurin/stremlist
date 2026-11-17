import type { TitleType } from "@stremlist/shared/constants";
import { IMDB_TITLE_ID_PATTERN } from "@stremlist/shared/constants";
import { z } from "zod";
import { scheduleBackgroundTask } from "../lib/background";
import { mapWithConcurrency } from "../lib/concurrency";
import { LruCache } from "../lib/lru";
import { supabase } from "../lib/supabase";
import { isTmdbConfigured, tmdbGet } from "./tmdb";

const TMDB_IMAGES = "https://image.tmdb.org/t/p";
/** A stored poster is checked again after this long. */
const FOUND_TTL_MS = 30 * 24 * 60 * 60_000;
/** A Title without a TMDB poster is checked again sooner: TMDB may add one. */
const MISSING_TTL_MS = 7 * 24 * 60 * 60_000;
const MEMORY_TTL_MS = 6 * 60 * 60_000;
/** After a failed TMDB request, no lookup for this long: IMDb posters show. */
const FAILURE_PAUSE_MS = 60_000;
/** Most TMDB lookups that one call starts: one Stremio catalog page. */
const MAX_LOOKUPS = 100;
const CONCURRENCY = 6;
const DB_CHUNK = 200;
const POSTER_PATH = /^\/[\w.-]+$/u;

/**
 * The TMDB poster path of each Title (IMDb ID), or null when TMDB has none.
 * A poster does not depend on the Account that asks, so every Account shares
 * this cache; only the choice to show it is per Account.
 */
const memory = new LruCache<string, string | null>({
  maxEntries: 20_000,
  ttlMs: MEMORY_TTL_MS,
});
let pausedUntil = 0;
/**
 * The TMDB lookups that run now, by IMDb ID: concurrent requests (Stremio
 * asks for every Catalog at once) wait for them instead of asking again.
 */
const running = new Map<string, Promise<void>>();

export interface PosterTitle {
  id: string;
  type: TitleType;
}

/** Poster widths that TMDB serves. */
export type TmdbPosterSize = "w342" | "w500";

const findResultSchema = z.object({ poster_path: z.string().nullish() });
const findSchema = z.object({
  movie_results: z.array(findResultSchema).nullish(),
  tv_results: z.array(findResultSchema).nullish(),
});

function posterPath(value: string | null | undefined): string | null {
  return value && POSTER_PATH.test(value) ? value : null;
}

/** The TMDB poster path of one Title; throws when TMDB fails. */
async function lookUp(title: PosterTitle): Promise<string | null> {
  const data = await tmdbGet(`/find/${title.id}`, findSchema, {
    external_source: "imdb_id",
  });
  const movies = data?.movie_results ?? [];
  const shows = data?.tv_results ?? [];
  // An IMDb ID is one Title, but TMDB can list it as a movie and a show.
  const ordered =
    title.type === "series" ? [...shows, ...movies] : [...movies, ...shows];
  return (
    ordered.map((result) => posterPath(result.poster_path)).find(Boolean) ??
    null
  );
}

const storedRowSchema = z.object({
  imdb_id: z.string(),
  poster_path: z.string().nullable(),
  checked_at: z.string(),
});

/** The stored posters that are still fresh. A failed read finds none. */
async function readStored(ids: string[]): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += DB_CHUNK) {
    const { data, error } = await supabase
      .from("tmdb_posters")
      .select("imdb_id, poster_path, checked_at")
      .in("imdb_id", ids.slice(start, start + DB_CHUNK));
    if (error) {
      console.error("Failed to read the TMDB poster cache:", error.message);
      continue;
    }
    for (const row of z.array(storedRowSchema).parse(data)) {
      const path = posterPath(row.poster_path);
      const age = Date.now() - Date.parse(row.checked_at);
      if (age >= 0 && age < (path ? FOUND_TTL_MS : MISSING_TTL_MS)) {
        found.set(row.imdb_id, path);
      }
    }
  }
  return found;
}

/** Look up each Title on TMDB, then store what TMDB answered. */
async function lookUpAll(titles: PosterTitle[]): Promise<void> {
  const answered: { imdb_id: string; poster_path: string | null }[] = [];
  await mapWithConcurrency(titles, CONCURRENCY, async (title) => {
    if (Date.now() < pausedUntil) return;
    try {
      const path = await lookUp(title);
      memory.set(title.id, path, {
        ttlMs: Math.min(MEMORY_TTL_MS, path ? FOUND_TTL_MS : MISSING_TTL_MS),
      });
      answered.push({ imdb_id: title.id, poster_path: path });
    } catch (error) {
      // An outage or a rate limit: stop asking for a while. Nothing is
      // stored, so the Title is looked up again after the pause.
      if (Date.now() >= pausedUntil) {
        console.warn(
          "TMDB poster lookup failed, showing IMDb posters for now:",
          error instanceof Error ? error.message : error,
        );
      }
      pausedUntil = Date.now() + FAILURE_PAUSE_MS;
    }
  });
  if (answered.length === 0) return;
  const checkedAt = new Date().toISOString();
  const { error } = await supabase.from("tmdb_posters").upsert(
    answered.map((row) => ({ ...row, checked_at: checkedAt })),
    { onConflict: "imdb_id" },
  );
  if (error) {
    console.error("Failed to write the TMDB poster cache:", error.message);
  }
}

/**
 * The TMDB poster URL of each Title that has one. Posters in memory answer
 * at once. Stored and TMDB lookups get at most `budgetMs` together; what
 * takes longer goes on in the background, so the next request has it.
 * A Title left out (no TMDB poster, TMDB down, not yet looked up) keeps its
 * IMDb poster.
 */
export async function findTmdbPosters(
  titles: PosterTitle[],
  { budgetMs, size }: { budgetMs: number; size: TmdbPosterSize },
): Promise<Map<string, string>> {
  const unique = new Map<string, PosterTitle>();
  for (const title of titles) {
    if (IMDB_TITLE_ID_PATTERN.test(title.id) && !unique.has(title.id)) {
      unique.set(title.id, title);
    }
  }
  if (unique.size === 0 || !isTmdbConfigured()) return new Map();

  const unknown = [...unique.values()].filter(({ id }) => !memory.has(id));
  if (unknown.length > 0) {
    // One deadline for the stored posters and the TMDB lookups.
    const work = (async () => {
      const stored = await readStored(unknown.map(({ id }) => id));
      for (const [id, path] of stored) memory.set(id, path);
      // Another request may have looked a Title up during the read.
      const missing = unknown
        .filter(({ id }) => !stored.has(id) && !memory.has(id))
        .slice(0, MAX_LOOKUPS);
      if (missing.length === 0 || Date.now() < pausedUntil) return;
      const fresh = missing.filter(({ id }) => !running.has(id));
      const lookups = lookUpAll(fresh);
      for (const { id } of fresh) running.set(id, lookups);
      void lookups
        .finally(() => {
          for (const { id } of fresh) {
            if (running.get(id) === lookups) running.delete(id);
          }
        })
        .catch(() => undefined);
      await Promise.all([
        lookups,
        ...missing.flatMap(({ id }) => running.get(id) ?? []),
      ]);
    })().catch((error: unknown) => {
      // Posters never fail a request: the Titles keep their IMDb posters.
      console.error(
        "TMDB poster lookup failed:",
        error instanceof Error ? error.message : error,
      );
    });
    if (Number.isFinite(budgetMs)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        work,
        new Promise((resolve) => {
          timer = setTimeout(resolve, budgetMs);
        }),
      ]);
      clearTimeout(timer);
      scheduleBackgroundTask(() => work);
    } else {
      await work;
    }
  }

  const urls = new Map<string, string>();
  for (const id of unique.keys()) {
    const path = memory.get(id);
    if (path) urls.set(id, `${TMDB_IMAGES}/${size}${path}`);
  }
  return urls;
}

/** For tests: forget the in-memory cache and any pause after a failure. */
export function resetTmdbPosterMemory(): void {
  memory.clear();
  running.clear();
  pausedUntil = 0;
}
