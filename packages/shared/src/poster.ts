/**
 * Where the posters of an Account come from. IMDb is the default and the
 * posters that Stremlist always showed. An RPDB key replaces both.
 */
export const POSTER_SOURCES = ["imdb", "tmdb"] as const;
export type PosterSource = (typeof POSTER_SOURCES)[number];
export const DEFAULT_POSTER_SOURCE: PosterSource = "imdb";

export function isPosterSource(value: unknown): value is PosterSource {
  return POSTER_SOURCES.some((source) => source === value);
}

/** The poster of a Title from each source that Stremlist knows. */
export interface TitlePosters {
  /** The IMDb poster, or Cinemeta's when IMDb had none. */
  imdb: string | null;
  /** The TMDB poster; null or absent when TMDB has none or did not answer. */
  tmdb?: string | null;
}

/**
 * The poster that Stremio and the configure page show for a Title. An RPDB
 * key wins. Without one, the chosen source; when TMDB has no poster for the
 * Title, the IMDb poster.
 */
export function choosePoster(
  imdbId: string,
  posters: TitlePosters,
  settings: { posterSource: PosterSource; rpdbApiKey?: string | null },
): string | null {
  const fallback =
    settings.posterSource === "tmdb"
      ? (posters.tmdb ?? posters.imdb)
      : posters.imdb;
  return buildPosterUrl(imdbId, fallback, settings.rpdbApiKey);
}

export function buildPosterUrl(
  imdbId: string,
  fallbackPosterUrl: string | null,
  rpdbApiKey?: string | null,
): string | null {
  const normalizedKey = rpdbApiKey?.trim();
  if (!normalizedKey) {
    return fallbackPosterUrl;
  }

  return `https://api.ratingposterdb.com/${encodeURIComponent(normalizedKey)}/imdb/poster-default/${imdbId}.jpg?fallback=true`;
}
