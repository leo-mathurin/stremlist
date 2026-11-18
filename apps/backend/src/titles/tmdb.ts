import { asImdbId } from "@stremlist/shared/constants";
import type { TitleType } from "@stremlist/shared/constants";
import { z } from "zod";
import { mapWithConcurrency } from "../lib/concurrency";
import { HttpError, providerFetchJson, RateLimiter } from "../providers/http";
import type { ResolverStrategy, SourceEntry } from "../providers/types";

const TMDB_API = "https://api.themoviedb.org/3";
const tmdbLimiter = new RateLimiter(30, 1000);
const CONCURRENCY = 6;

export function isTmdbConfigured() {
  return (
    Boolean(process.env.TMDB_READ_ACCESS_TOKEN) ||
    Boolean(process.env.TMDB_API_KEY)
  );
}

/** GET a TMDB v3 endpoint. Returns null on 404; throws HttpError otherwise. */
export async function tmdbGet<T>(
  path: string,
  schema: z.ZodType<T>,
  params: Record<string, string> = {},
) {
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

async function tmdbImdbId(tmdbId: number, type: "movie" | "series") {
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

const findResultSchema = z.object({ poster_path: z.string().nullish() });
const findSchema = z.object({
  movie_results: z.array(findResultSchema).nullish(),
  tv_results: z.array(findResultSchema).nullish(),
});
const POSTER_PATH = /^\/[\w.-]+$/u;

/** Whether `value` is a TMDB image path that is safe to put in a URL. */
export function isTmdbPosterPath(value: string) {
  return POSTER_PATH.test(value);
}

/**
 * The TMDB poster path of one Title, found by its IMDb ID, or null when TMDB
 * has none. Throws when TMDB fails.
 */
export async function findTmdbPosterPath(title: {
  id: string;
  type: TitleType;
}) {
  const data = await tmdbGet(`/find/${title.id}`, findSchema, {
    external_source: "imdb_id",
  });
  const movies = data?.movie_results ?? [];
  const shows = data?.tv_results ?? [];
  const ordered =
    title.type === "series" ? [...shows, ...movies] : [...movies, ...shows];
  return (
    ordered
      .map((result) => result.poster_path)
      .find((path): path is string => !!path && isTmdbPosterPath(path)) ?? null
  );
}
