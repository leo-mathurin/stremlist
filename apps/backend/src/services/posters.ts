import type { PosterSource } from "@stremlist/shared/poster";
import { choosePoster } from "@stremlist/shared/poster";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { findTmdbPosters } from "../titles/tmdb-posters";

/**
 * How long a Stremio request waits for TMDB posters it does not have yet.
 * The other Titles show their IMDb poster; their lookup goes on in the
 * background, so the next request shows TMDB posters.
 */
const STREMIO_POSTER_BUDGET_MS = 2_000;

/** The poster settings of an Account. */
export interface PosterSettings {
  posterSource: PosterSource;
  rpdbApiKey: string | null;
}

/** Whether the Account shows TMDB posters. */
export function showsTmdbPosters(settings: PosterSettings): boolean {
  return settings.posterSource === "tmdb";
}

/**
 * The metas with the posters that the Account chose (see `choosePoster`).
 * Call it on the Titles that Stremio receives, after paging, so a request
 * looks up only what it shows.
 */
export async function withAccountPosters<T extends StremioMeta>(
  metas: T[],
  settings: PosterSettings,
): Promise<T[]> {
  const tmdb = showsTmdbPosters(settings)
    ? await findTmdbPosters(metas, {
        budgetMs: STREMIO_POSTER_BUDGET_MS,
        size: "w500",
      })
    : new Map<string, string>();
  return metas.map((meta) => ({
    ...meta,
    poster: choosePoster(
      meta.id,
      { imdb: meta.poster, tmdb: tmdb.get(meta.id) },
      settings,
    ),
  }));
}
