import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { mapWithConcurrency } from "../lib/concurrency";
import { providerFetch, RateLimiter } from "../providers/http";
import { fetchTitlesByIds } from "../services/imdb-scraper";

const CINEMETA = "https://v3-cinemeta.strem.io";
const cinemetaLimiter = new RateLimiter(20, 1000);
const MEMORY_TTL_MS = 6 * 60 * 60_000;
const MEMORY_MAX_ENTRIES = 5000;
/** Most titles one refresh asks Cinemeta for when IMDb fails. */
const MAX_CINEMETA_TITLES = 200;

const memory = new Map<string, { meta: StremioMeta; expiresAt: number }>();

function remember(meta: StremioMeta): void {
  memory.delete(meta.id);
  memory.set(meta.id, { meta, expiresAt: Date.now() + MEMORY_TTL_MS });
  while (memory.size > MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (!oldest) break;
    memory.delete(oldest);
  }
}

function recall(imdbId: string): StremioMeta | null {
  const entry = memory.get(imdbId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(imdbId);
    return null;
  }
  return entry.meta;
}

interface CinemetaMeta {
  id?: string;
  name?: string;
  type?: string;
  poster?: string;
  genres?: string[];
  genre?: string[];
  description?: string;
  imdbRating?: string;
  releaseInfo?: string;
  year?: string;
  runtime?: string;
  released?: string;
  director?: string[];
  cast?: string[];
}

async function fetchCinemeta(
  imdbId: string,
  typeHint?: "movie" | "series",
): Promise<StremioMeta | null> {
  const types: ("movie" | "series")[] = typeHint
    ? [typeHint]
    : ["movie", "series"];
  for (const type of types) {
    const response = await providerFetch(
      `${CINEMETA}/meta/${type}/${imdbId}.json`,
      { limiter: cinemetaLimiter },
    );
    if (!response.ok) continue;
    const { meta } = (await response.json()) as { meta?: CinemetaMeta | null };
    if (!meta?.name) continue;
    const released =
      meta.released && !Number.isNaN(Date.parse(meta.released))
        ? new Date(meta.released).toISOString()
        : undefined;
    return {
      id: imdbId,
      name: meta.name,
      poster: meta.poster ?? null,
      posterShape: "poster",
      type,
      genres: meta.genres ?? meta.genre ?? [],
      description: meta.description ?? "",
      ...(meta.imdbRating ? { imdbRating: meta.imdbRating } : {}),
      ...(meta.releaseInfo || meta.year
        ? { releaseInfo: (meta.releaseInfo ?? meta.year ?? "").slice(0, 4) }
        : {}),
      ...(meta.runtime ? { runtime: meta.runtime.replace(/ min$/, "m") } : {}),
      ...(released ? { released } : {}),
      ...(meta.director?.length ? { director: meta.director } : {}),
      ...(meta.cast?.length ? { cast: meta.cast.slice(0, 5) } : {}),
    };
  }
  return null;
}

interface TitleToEnrich {
  imdbId: string;
  type?: "movie" | "series";
}

/**
 * Stremio metadata for Titles, the same for every Provider (decision 9 in
 * STR-16). Order of sources: metadata from the previous cache generation,
 * the in-memory cache, IMDb's GraphQL API in batches (same fields and ratings
 * as IMDb Lists), then Cinemeta for anything IMDb could not answer.
 */
export async function enrichTitles(
  titles: TitleToEnrich[],
  previous = new Map<string, StremioMeta>(),
): Promise<Map<string, StremioMeta>> {
  const result = new Map<string, StremioMeta>();
  const missing = new Map<string, TitleToEnrich>();
  // A Source list can hold a Title twice (history, two seasons): look it up once.
  for (const title of titles) {
    if (result.has(title.imdbId) || missing.has(title.imdbId)) continue;
    const known = previous.get(title.imdbId) ?? recall(title.imdbId);
    if (known) result.set(title.imdbId, known);
    else missing.set(title.imdbId, title);
  }
  if (missing.size === 0) return result;

  let notFromImdb = [...missing.values()];
  try {
    const fromImdb = await fetchTitlesByIds([...missing.keys()]);
    for (const meta of fromImdb.values()) {
      result.set(meta.id, meta);
      remember(meta);
    }
    notFromImdb = notFromImdb.filter((title) => !fromImdb.has(title.imdbId));
  } catch (error) {
    console.error(
      "IMDb title lookup failed, falling back to Cinemeta:",
      error instanceof Error ? error.message : error,
    );
  }

  const forCinemeta = notFromImdb.slice(0, MAX_CINEMETA_TITLES);
  await mapWithConcurrency(forCinemeta, 6, async (title) => {
    try {
      const meta = await fetchCinemeta(title.imdbId, title.type);
      if (meta) {
        result.set(meta.id, meta);
        remember(meta);
      }
    } catch (error) {
      console.error(
        `Cinemeta lookup failed for ${title.imdbId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  });
  return result;
}
