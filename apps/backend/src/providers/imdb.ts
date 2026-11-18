import {
  IMDB_LIST_ID_PATTERN,
  IMDB_RATINGS_REF_PATTERN,
  IMDB_USER_ID_PATTERN,
} from "@stremlist/shared/constants";
import { CHART_BY_ID, isChartId } from "@stremlist/shared/imdb-charts";
import {
  classifyImdbError,
  fetchChart,
  fetchList,
  fetchRatings,
  fetchWatchlist,
  isListId,
  validateImdbList,
  validateImdbRatings,
  validateImdbWatchlist,
} from "../services/imdb-scraper";
import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

function readSource(ref: string) {
  if (isChartId(ref)) return fetchChart(ref);
  if (isListId(ref)) return fetchList(ref);
  const ratings = IMDB_RATINGS_REF_PATTERN.exec(ref);
  if (ratings) return fetchRatings(ratings[1]);
  return fetchWatchlist(ref);
}

const CACHE_TTL_MS =
  (Number.isFinite(Number(process.env.CACHE_TTL_MINUTES))
    ? Number(process.env.CACHE_TTL_MINUTES)
    : 30) * 60_000;

/**
 * IMDb: public watchlists (`ur…`, or a `p.` handle resolved to `ur…`), public
 * ratings (`ur…/ratings`), public lists (`ls…`) and the built-in charts
 * (`imdb:…`), read through IMDb's GraphQL API. Entries come with full
 * metadata, so they skip enrichment.
 */
export const imdbProvider: ProviderAdapter = {
  id: "imdb",
  freshnessMs: CACHE_TTL_MS,

  async validateSource(ref) {
    if (isChartId(ref)) {
      const chart = CHART_BY_ID.get(ref);
      return chart
        ? {
            ok: true,
            ref,
            suggestedTitle: chart.label,
            defaultDisplayMode: chart.defaultDisplayMode,
          }
        : { ok: false, reason: "not_found" };
    }
    if (IMDB_LIST_ID_PATTERN.test(ref)) {
      const result = await validateImdbList(ref);
      return result.valid
        ? { ok: true, ref }
        : { ok: false, reason: result.reason };
    }
    const ratings = IMDB_RATINGS_REF_PATTERN.exec(ref);
    if (ratings) {
      const result = await validateImdbRatings(ratings[1]);
      return result.valid
        ? { ok: true, ref: `${result.userId}/ratings` }
        : { ok: false, reason: result.reason };
    }
    if (IMDB_USER_ID_PATTERN.test(ref)) {
      const result = await validateImdbWatchlist(ref);
      return result.valid
        ? { ok: true, ref: result.userId }
        : { ok: false, reason: result.reason };
    }
    return { ok: false, reason: "not_found" };
  },

  async fetchSource(ref) {
    try {
      const data = await readSource(ref);
      return {
        entries: data.metas.map((meta) => {
          const addedAt = data.addedAt?.get(meta.id);
          return { imdbId: meta.id, meta, ...(addedAt ? { addedAt } : {}) };
        }),
        complete: data.complete,
      };
    } catch (error) {
      const reason = classifyImdbError(error);
      if (reason) {
        throw new SourceUnavailableError(
          reason,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  },
};
