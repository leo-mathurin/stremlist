import type { PosterSource } from "@stremlist/shared/poster";
import { choosePoster } from "@stremlist/shared/poster";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { findPosters } from "../titles/title-posters";

const STREMIO_POSTER_BUDGET_MS = 2_000;
const IMDB_TITLE_ID = /^tt\d+$/u;

/**
 * The background and logo that Cinemeta gives a Title, from the same image
 * host. Stremio's Board Spotlight shows only Titles with a background.
 */
export function titleArtwork(id: string) {
  if (!IMDB_TITLE_ID.test(id)) return {};
  return {
    background: `https://images.metahub.space/background/medium/${id}/img`,
    logo: `https://images.metahub.space/logo/medium/${id}/img`,
  };
}

/** The poster settings of an Account. */
export interface PosterSettings {
  posterSource: PosterSource;
  rpdbApiKey: string | null;
}

/** The source that the Account's posters are looked up on, if any. */
export function lookupSourceOf(settings: PosterSettings) {
  const source = settings.posterSource;
  return source === "tmdb" || source === "tvdb" ? source : null;
}

/**
 * The metas with the posters that the Account chose (see `choosePoster`)
 * and their artwork (see `titleArtwork`).
 * Call it on the Titles that Stremio receives, after paging, so a request
 * looks up only what it shows.
 */
export async function withAccountPosters<T extends StremioMeta>(
  metas: T[],
  settings: PosterSettings,
) {
  const source = lookupSourceOf(settings);
  const found = source
    ? await findPosters(source, metas, {
        budgetMs: STREMIO_POSTER_BUDGET_MS,
        size: "stremio",
      })
    : new Map<string, string>();
  return metas.map((meta) => ({
    ...meta,
    ...titleArtwork(meta.id),
    poster: choosePoster(
      meta.id,
      source
        ? { imdb: meta.poster, [source]: found.get(meta.id) }
        : { imdb: meta.poster },
      settings,
    ),
  }));
}
