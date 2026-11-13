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
