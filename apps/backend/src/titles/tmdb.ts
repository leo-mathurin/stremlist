import { providerFetch, RateLimiter } from "../providers/http";
import type { ResolverStrategy, SourceEntry } from "../providers/types";

const TMDB_API = "https://api.themoviedb.org/3";
// TMDB allows about 50 requests per second; stay well below.
const tmdbLimiter = new RateLimiter(30, 1000);
const CONCURRENCY = 6;

export function isTmdbConfigured(): boolean {
  return (
    Boolean(process.env.TMDB_READ_ACCESS_TOKEN) ||
    Boolean(process.env.TMDB_API_KEY)
  );
}

/** GET a TMDB v3 endpoint. Returns null on 404. */
export async function tmdbGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  const url = new URL(`${TMDB_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.TMDB_READ_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.TMDB_READ_ACCESS_TOKEN}`;
  } else if (process.env.TMDB_API_KEY) {
    url.searchParams.set("api_key", process.env.TMDB_API_KEY);
  } else {
    throw new Error("TMDB is not configured");
  }
  const response = await providerFetch(url.toString(), {
    headers,
    limiter: tmdbLimiter,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TMDB ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** Run `task` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** IMDb ID of a TMDB movie or show, or null. */
export async function tmdbImdbId(
  tmdbId: number,
  type: "movie" | "series",
): Promise<string | null> {
  const data = await tmdbGet<{ imdb_id?: string | null }>(
    `/${type === "movie" ? "movie" : "tv"}/${tmdbId}/external_ids`,
  );
  return data?.imdb_id && /^tt\d+$/.test(data.imdb_id) ? data.imdb_id : null;
}

/**
 * Resolver strategy for entries that carry a TMDB ID but no IMDb ID (some
 * Trakt, Simkl and MDBList items, new releases, anime).
 */
export const tmdbExternalIdsStrategy: ResolverStrategy = {
  name: "tmdb-external-ids",
  async resolve(entries: SourceEntry[]) {
    const found = new Map<number, string>();
    if (!isTmdbConfigured()) return found;
    await mapWithConcurrency(entries, CONCURRENCY, async (entry, index) => {
      const tmdb = entry.externalIds?.tmdb;
      if (!tmdb) return;
      const imdbId = await tmdbImdbId(tmdb.id, tmdb.type);
      if (imdbId) found.set(index, imdbId);
    });
    return found;
  },
};
