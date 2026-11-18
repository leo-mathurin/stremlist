import type { TitleType } from "@stremlist/shared/constants";
import { IMDB_TITLE_ID_PATTERN } from "@stremlist/shared/constants";
import { z } from "zod";
import { scheduleBackgroundTask } from "../lib/background";
import { mapWithConcurrency } from "../lib/concurrency";
import { LruCache } from "../lib/lru";
import { supabase } from "../lib/supabase";
import { findTmdbPosterPath, isTmdbConfigured, isTmdbPosterPath } from "./tmdb";
import { findTvdbPosterUrl, isTvdbConfigured, tvdbThumbnailUrl } from "./tvdb";

const FOUND_TTL_MS = 30 * 24 * 60 * 60_000;
const MISSING_TTL_MS = 7 * 24 * 60 * 60_000;
const MEMORY_TTL_MS = 6 * 60 * 60_000;
const FAILURE_PAUSE_MS = 60_000;
const MAX_LOOKUPS = 100;
const CONCURRENCY = 6;
const DB_CHUNK = 200;
const TMDB_IMAGES = "https://image.tmdb.org/t/p";

/** The poster sources that Stremlist looks up by IMDb ID. */
export type LookupSource = "tmdb" | "tvdb";

/** The poster for Stremio, or the smaller one for the configure page. */
export type PosterSize = "preview" | "stremio";

export interface PosterTitle {
  id: string;
  type: TitleType;
}

interface SourceSpec {
  name: string;
  configured(): boolean;
  lookUp(title: PosterTitle): Promise<string | null>;
  valid(stored: string): boolean;
  url(stored: string, size: PosterSize): string;
}

const SOURCES: Record<LookupSource, SourceSpec> = {
  tmdb: {
    name: "TMDB",
    configured: isTmdbConfigured,
    lookUp: findTmdbPosterPath,
    valid: isTmdbPosterPath,
    url: (path, size) =>
      `${TMDB_IMAGES}/${size === "preview" ? "w342" : "w500"}${path}`,
  },
  tvdb: {
    name: "TheTVDB",
    configured: isTvdbConfigured,
    lookUp: findTvdbPosterUrl,
    valid: (url) => url.startsWith("https://artworks.thetvdb.com/"),
    url: (url, size) => (size === "preview" ? tvdbThumbnailUrl(url) : url),
  },
};

const memory = new LruCache<string, string | null>({
  maxEntries: 40_000,
  ttlMs: MEMORY_TTL_MS,
});
const pausedUntil: Record<LookupSource, number> = { tmdb: 0, tvdb: 0 };
const running = new Map<string, Promise<void>>();

const memoryKey = (source: LookupSource, id: string) => `${source}:${id}`;

const storedRowSchema = z.object({
  imdb_id: z.string(),
  poster: z.string().nullable(),
  checked_at: z.string(),
});

async function readStored(source: LookupSource, ids: string[]) {
  const found = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += DB_CHUNK) {
    const { data, error } = await supabase
      .from("title_posters")
      .select("imdb_id, poster, checked_at")
      .eq("source", source)
      .in("imdb_id", ids.slice(start, start + DB_CHUNK));
    if (error) {
      console.error("Failed to read the poster cache:", error.message);
      continue;
    }
    for (const row of z.array(storedRowSchema).parse(data)) {
      const poster =
        row.poster && SOURCES[source].valid(row.poster) ? row.poster : null;
      const age = Date.now() - Date.parse(row.checked_at);
      if (age >= 0 && age < (poster ? FOUND_TTL_MS : MISSING_TTL_MS)) {
        found.set(row.imdb_id, poster);
      }
    }
  }
  return found;
}

async function lookUpAll(source: LookupSource, titles: PosterTitle[]) {
  const spec = SOURCES[source];
  const answered: { imdb_id: string; poster: string | null }[] = [];
  await mapWithConcurrency(titles, CONCURRENCY, async (title) => {
    if (Date.now() < pausedUntil[source]) return;
    try {
      const poster = await spec.lookUp(title);
      memory.set(memoryKey(source, title.id), poster, {
        ttlMs: Math.min(MEMORY_TTL_MS, poster ? FOUND_TTL_MS : MISSING_TTL_MS),
      });
      answered.push({ imdb_id: title.id, poster });
    } catch (error) {
      if (Date.now() >= pausedUntil[source]) {
        console.warn(
          `${spec.name} poster lookup failed, showing IMDb posters for now:`,
          error instanceof Error ? error.message : error,
        );
      }
      pausedUntil[source] = Date.now() + FAILURE_PAUSE_MS;
    }
  });
  if (answered.length === 0) return;
  const checkedAt = new Date().toISOString();
  const { error } = await supabase.from("title_posters").upsert(
    answered.map((row) => ({ ...row, source, checked_at: checkedAt })),
    { onConflict: "source,imdb_id" },
  );
  if (error) {
    console.error("Failed to write the poster cache:", error.message);
  }
}

/**
 * The poster URL from `source` of each Title that has one. Posters in
 * memory answer at once. Stored and new lookups get at most `budgetMs`
 * together; what takes longer goes on in the background, so the next
 * request has it. A Title left out (no poster on the source, the source
 * down, not yet looked up) keeps its IMDb poster.
 */
export async function findPosters(
  source: LookupSource,
  titles: PosterTitle[],
  { budgetMs, size }: { budgetMs: number; size: PosterSize },
) {
  const spec = SOURCES[source];
  const unique = new Map<string, PosterTitle>();
  for (const title of titles) {
    if (IMDB_TITLE_ID_PATTERN.test(title.id) && !unique.has(title.id)) {
      unique.set(title.id, title);
    }
  }
  if (unique.size === 0 || !spec.configured()) return new Map();

  const unknown = [...unique.values()].filter(
    ({ id }) => !memory.has(memoryKey(source, id)),
  );
  if (unknown.length > 0) {
    const work = (async () => {
      const stored = await readStored(
        source,
        unknown.map(({ id }) => id),
      );
      for (const [id, poster] of stored) {
        memory.set(memoryKey(source, id), poster);
      }
      const missing = unknown
        .filter(
          ({ id }) => !stored.has(id) && !memory.has(memoryKey(source, id)),
        )
        .slice(0, MAX_LOOKUPS);
      if (missing.length === 0 || Date.now() < pausedUntil[source]) return;
      const fresh = missing.filter(
        ({ id }) => !running.has(memoryKey(source, id)),
      );
      const lookups = lookUpAll(source, fresh);
      for (const { id } of fresh) running.set(memoryKey(source, id), lookups);
      void lookups
        .finally(() => {
          for (const { id } of fresh) {
            const key = memoryKey(source, id);
            if (running.get(key) === lookups) running.delete(key);
          }
        })
        .catch(() => undefined);
      await Promise.all([
        lookups,
        ...missing.flatMap(
          ({ id }) => running.get(memoryKey(source, id)) ?? [],
        ),
      ]);
    })().catch((error: unknown) => {
      console.error(
        `${spec.name} poster lookup failed:`,
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
    const poster = memory.get(memoryKey(source, id));
    if (poster) urls.set(id, spec.url(poster, size));
  }
  return urls;
}

/** For tests: forget the in-memory cache and any pause after a failure. */
export function resetPosterMemory() {
  memory.clear();
  running.clear();
  pausedUntil.tmdb = 0;
  pausedUntil.tvdb = 0;
}
