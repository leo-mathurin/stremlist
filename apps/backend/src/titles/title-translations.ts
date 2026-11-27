import type { TitleType } from "@stremlist/shared/constants";
import { IMDB_TITLE_ID_PATTERN } from "@stremlist/shared/constants";
import type { LocalizedMetadataLanguage } from "@stremlist/shared/metadata-language";
import { z } from "zod";
import { scheduleBackgroundTask } from "../lib/background";
import { mapWithConcurrency } from "../lib/concurrency";
import { LruCache } from "../lib/lru";
import { supabase } from "../lib/supabase";
import { findTmdbTranslation, isTmdbConfigured } from "./tmdb";

const FOUND_TTL_MS = 30 * 24 * 60 * 60_000;
const MISSING_TTL_MS = 7 * 24 * 60 * 60_000;
const MEMORY_TTL_MS = 6 * 60 * 60_000;
const FAILURE_PAUSE_MS = 60_000;
const LOOKUP_BATCH_SIZE = 100;
const CONCURRENCY = 6;
const DB_CHUNK = 200;

export interface TranslatableTitle {
  id: string;
  type: TitleType;
}

export interface TitleTranslation {
  title: string | null;
  description: string | null;
}

const memory = new LruCache<string, TitleTranslation>({
  maxEntries: 40_000,
  ttlMs: MEMORY_TTL_MS,
});
let pausedUntil = 0;
const inFlight = new Map<string, Promise<void>>();

const memoryKey = (language: LocalizedMetadataLanguage, id: string) =>
  `${language}:${id}`;

const hasTranslation = (entry: TitleTranslation) =>
  entry.title !== null || entry.description !== null;

const storedRowSchema = z.object({
  imdb_id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  checked_at: z.string(),
});

async function readStored(language: LocalizedMetadataLanguage, ids: string[]) {
  const found = new Map<string, TitleTranslation>();
  for (let start = 0; start < ids.length; start += DB_CHUNK) {
    const { data, error } = await supabase
      .from("title_translations")
      .select("imdb_id, title, description, checked_at")
      .eq("language", language)
      .in("imdb_id", ids.slice(start, start + DB_CHUNK));
    if (error) {
      console.error("Failed to read the translation cache:", error.message);
      continue;
    }
    for (const row of z.array(storedRowSchema).parse(data)) {
      const entry: TitleTranslation = {
        title: row.title?.trim() || null,
        description: row.description?.trim() || null,
      };
      const age = Date.now() - Date.parse(row.checked_at);
      const ttl = hasTranslation(entry) ? FOUND_TTL_MS : MISSING_TTL_MS;
      if (age >= 0 && age < ttl) {
        found.set(row.imdb_id, entry);
      }
    }
  }
  return found;
}

async function lookUpAll(
  language: LocalizedMetadataLanguage,
  titles: TranslatableTitle[],
) {
  if (titles.length === 0 || Date.now() < pausedUntil) return;
  const answered: {
    imdb_id: string;
    title: string | null;
    description: string | null;
  }[] = [];
  await mapWithConcurrency(titles, CONCURRENCY, async (title) => {
    const key = memoryKey(language, title.id);
    if (memory.has(key) || Date.now() < pausedUntil) return;
    const active = inFlight.get(key);
    if (active) {
      await active;
      return;
    }
    const lookup = (async () => {
      try {
        const entry = await findTmdbTranslation(title, language);
        memory.set(key, entry, {
          ttlMs: Math.min(
            MEMORY_TTL_MS,
            hasTranslation(entry) ? FOUND_TTL_MS : MISSING_TTL_MS,
          ),
        });
        answered.push({
          imdb_id: title.id,
          title: entry.title,
          description: entry.description,
        });
      } catch (error) {
        if (Date.now() >= pausedUntil) {
          console.warn(
            `TMDB ${language} translation lookup failed, keeping English metadata for now:`,
            error instanceof Error ? error.message : error,
          );
        }
        pausedUntil = Date.now() + FAILURE_PAUSE_MS;
      }
    })();
    inFlight.set(key, lookup);
    try {
      await lookup;
    } finally {
      if (inFlight.get(key) === lookup) inFlight.delete(key);
    }
  });
  if (answered.length === 0) return;
  const checkedAt = new Date().toISOString();
  const { error } = await supabase.from("title_translations").upsert(
    answered.map((row) => ({ ...row, language, checked_at: checkedAt })),
    { onConflict: "language,imdb_id" },
  );
  if (error) {
    console.error("Failed to write the translation cache:", error.message);
  }
}

/**
 * The TMDB localized title and plot summary in `language` for each Title that
 * has one. Translations in memory answer at once. Stored and new lookups get
 * at most `budgetMs` together; what takes longer goes on in the background, so
 * the next request has it. Any missing or failed Title keeps English metadata.
 */
export async function findTranslations(
  language: LocalizedMetadataLanguage,
  titles: TranslatableTitle[],
  { budgetMs }: { budgetMs: number },
) {
  const unique = new Map<string, TranslatableTitle>();
  for (const title of titles) {
    if (IMDB_TITLE_ID_PATTERN.test(title.id) && !unique.has(title.id)) {
      unique.set(title.id, title);
    }
  }
  if (unique.size === 0 || !isTmdbConfigured()) {
    return new Map<string, TitleTranslation>();
  }

  const unknown = [...unique.values()].filter(
    ({ id }) => !memory.has(memoryKey(language, id)),
  );
  if (unknown.length > 0) {
    const work = (async () => {
      const stored = await readStored(
        language,
        unknown.map(({ id }) => id),
      );
      for (const [id, entry] of stored) {
        memory.set(memoryKey(language, id), entry);
      }
      const missing = unknown.filter(
        ({ id }) => !stored.has(id) && !memory.has(memoryKey(language, id)),
      );
      if (missing.length === 0 || Date.now() < pausedUntil) return;
      for (let start = 0; start < missing.length; start += LOOKUP_BATCH_SIZE) {
        if (Date.now() < pausedUntil) break;
        await lookUpAll(
          language,
          missing.slice(start, start + LOOKUP_BATCH_SIZE),
        );
      }
    })().catch((error: unknown) => {
      console.error(
        `TMDB ${language} translation lookup failed:`,
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

  const found = new Map<string, TitleTranslation>();
  for (const id of unique.keys()) {
    const entry = memory.get(memoryKey(language, id));
    if (entry && hasTranslation(entry)) found.set(id, entry);
  }
  return found;
}

/** For tests: forget the in-memory translation cache and any failure pause. */
export function resetTranslationMemory() {
  memory.clear();
  inFlight.clear();
  pausedUntil = 0;
}
