import { asImdbId } from "@stremlist/shared/constants";
import { z } from "zod";
import { mapWithConcurrency } from "../lib/concurrency";
import { HttpError, providerFetchJson, RateLimiter } from "../providers/http";
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

/** GET a TMDB v3 endpoint. Returns null on 404; throws HttpError otherwise. */
export async function tmdbGet<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  params: Record<string, string> = {},
): Promise<T | null> {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  if (!token && !apiKey) throw new Error("TMDB is not configured");
  try {
    const { data } = await providerFetchJson(`${TMDB_API}${path}`, {
      query: token ? params : { ...params, api_key: apiKey ?? "" },
      headers: { Accept: "application/json" },
      bearer: token,
      limiter: tmdbLimiter,
    });
    return schema.parse(data);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

const externalIdsSchema = z.object({ imdb_id: z.string().nullish() });

/** IMDb ID of a TMDB movie or show, or null. */
async function tmdbImdbId(
  tmdbId: number,
  type: "movie" | "series",
): Promise<string | null> {
  const data = await tmdbGet(
    `/${type === "movie" ? "movie" : "tv"}/${tmdbId}/external_ids`,
    externalIdsSchema,
  );
  return asImdbId(data?.imdb_id) ?? null;
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
