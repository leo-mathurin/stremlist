import type { PosterSource } from "@stremlist/shared/poster";
import { choosePoster } from "@stremlist/shared/poster";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import type { LookupSource } from "../titles/title-posters";
import { findPosters } from "../titles/title-posters";

/**
 * How long a Stremio request waits for TMDB or TheTVDB posters it does not
 * have yet. The other Titles show their IMDb poster; their lookup goes on in
 * the background, so the next request shows the chosen posters.
 */
const STREMIO_POSTER_BUDGET_MS = 2_000;

/** The poster settings of an Account. */
export interface PosterSettings {
  posterSource: PosterSource;
  rpdbApiKey: string | null;
}

/** The source that the Account's posters are looked up on, if any. */
export function lookupSourceOf(settings: PosterSettings): LookupSource | null {
  const source = settings.posterSource;
  return source === "tmdb" || source === "tvdb" ? source : null;
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
  const source = lookupSourceOf(settings);
  const found = source
    ? await findPosters(source, metas, {
        budgetMs: STREMIO_POSTER_BUDGET_MS,
        size: "stremio",
      })
    : new Map<string, string>();
  return metas.map((meta) => ({
    ...meta,
    poster: choosePoster(
      meta.id,
      source
        ? { imdb: meta.poster, [source]: found.get(meta.id) }
        : { imdb: meta.poster },
      settings,
    ),
  }));
}
