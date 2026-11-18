/**
 * Where the posters of an Account come from. IMDb is the default and the
 * posters that Stremlist always showed. RPDB needs the Account's RPDB key.
 */
export const POSTER_SOURCES = ["imdb", "tmdb", "tvdb", "rpdb"] as const;
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
  /** The TheTVDB poster, with the same rule. */
  tvdb?: string | null;
}

/** The RPDB poster of a Title. RPDB shows its own image when it has none. */
export function rpdbPosterUrl(rpdbApiKey: string, imdbId: string): string {
  return `https://api.ratingposterdb.com/${encodeURIComponent(rpdbApiKey.trim())}/imdb/poster-default/${imdbId}.jpg?fallback=true`;
}

/**
 * The poster that Stremio and the configure page show for a Title: the
 * chosen source. RPDB without a key shows the IMDb poster, and so do TMDB and
 * TheTVDB when they have no poster for the Title.
 */
export function choosePoster(
  imdbId: string,
  posters: TitlePosters,
  settings: { posterSource: PosterSource; rpdbApiKey?: string | null },
): string | null {
  switch (settings.posterSource) {
    case "rpdb":
      return settings.rpdbApiKey?.trim()
        ? rpdbPosterUrl(settings.rpdbApiKey, imdbId)
        : posters.imdb;
    case "tmdb":
      return posters.tmdb ?? posters.imdb;
    case "tvdb":
      return posters.tvdb ?? posters.imdb;
    case "imdb":
      return posters.imdb;
  }
}
