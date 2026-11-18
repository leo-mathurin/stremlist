import type { TitleType } from "@stremlist/shared/constants";
import { z } from "zod";
import { HttpError, providerFetchJson, RateLimiter } from "../providers/http";

const TVDB_API = "https://api4.thetvdb.com/v4";
// TheTVDB publishes no rate limit; stay gentle.
const tvdbLimiter = new RateLimiter(20, 1000);
/** A login token lasts about a month; log in again well before. */
const TOKEN_TTL_MS = 24 * 60 * 60_000;
const ARTWORK_URL =
  /^https:\/\/artworks\.thetvdb\.com\/[\w./-]+\.(?:jpe?g|png|webp)$/u;

export function isTvdbConfigured(): boolean {
  return Boolean(process.env.TVDB_API_KEY);
}

const loginSchema = z.object({ data: z.object({ token: z.string() }) });

let token: { value: Promise<string>; expiresAt: number } | null = null;

/** A login token, shared by concurrent requests. */
function loginToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;
  const apiKey = process.env.TVDB_API_KEY;
  if (!apiKey) throw new Error("TheTVDB is not configured");
  const value = providerFetchJson(`${TVDB_API}/login`, {
    method: "POST",
    json: { apikey: apiKey },
    headers: { Accept: "application/json" },
    limiter: tvdbLimiter,
  }).then(({ data }) => loginSchema.parse(data).data.token);
  const entry = { value, expiresAt: Date.now() + TOKEN_TTL_MS };
  token = entry;
  // A failed login is not kept: the next lookup tries again.
  value.catch(() => {
    if (token === entry) token = null;
  });
  return value;
}

/** GET a TheTVDB v4 endpoint. Null on 404; a refused token logs in again. */
async function tvdbGet<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await providerFetchJson(`${TVDB_API}${path}`, {
        headers: { Accept: "application/json" },
        bearer: await loginToken(),
        limiter: tvdbLimiter,
      });
      return schema.parse(data);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      if (error instanceof HttpError && error.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      throw error;
    }
  }
}

const recordSchema = z.object({ image: z.string().nullish() }).nullish();
const remoteIdSchema = z.object({
  data: z
    .array(z.object({ series: recordSchema, movie: recordSchema }))
    .nullish(),
});

function artworkUrl(value: string | null | undefined): string | null {
  return value && ARTWORK_URL.test(value) ? value : null;
}

/**
 * The TheTVDB poster URL of one Title, found by its IMDb ID, or null when
 * TheTVDB has none. Throws when TheTVDB fails.
 */
export async function findTvdbPosterUrl(title: {
  id: string;
  type: TitleType;
}): Promise<string | null> {
  const found = await tvdbGet(`/search/remoteid/${title.id}`, remoteIdSchema);
  const results = found?.data ?? [];
  // An IMDb ID can match records of other kinds (an episode, a season):
  // only series and movies have a poster, the Title's own kind first.
  const series = results.map((result) => result.series?.image);
  const movies = results.map((result) => result.movie?.image);
  const ordered =
    title.type === "series" ? [...series, ...movies] : [...movies, ...series];
  return ordered.map(artworkUrl).find(Boolean) ?? null;
}

/** The small version of a TheTVDB artwork (the preview's size). */
export function tvdbThumbnailUrl(url: string): string {
  return url.replace(/(\.[a-z]+)$/u, "_t$1");
}

/** For tests: forget the login token. */
export function resetTvdbToken(): void {
  token = null;
}
