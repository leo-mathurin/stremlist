import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import { z } from "zod";

export const IMDB_GRAPHQL = "https://api.graphql.imdb.com/";

/** Cinemeta, the fallback for Titles that IMDb does not answer, knows none. */
export const cinemetaWithoutTitles = http.get(
  "https://v3-cinemeta.strem.io/meta/:type/:id",
  () => HttpResponse.json({ meta: null }),
);

const imdbRequest = z.object({
  operationName: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

/** One GraphQL request that the IMDb API received. */
export type ImdbRequest = z.infer<typeof imdbRequest>;

/** An IMDb title node that the scraper turns back into `meta`. */
export function imdbTitle(meta: StremioMeta) {
  return {
    id: meta.id,
    titleText: { text: meta.name },
    titleType: { text: meta.type === "series" ? "TV Series" : "Movie" },
    releaseYear: meta.releaseInfo ? { year: Number(meta.releaseInfo) } : null,
    ratingsSummary: meta.imdbRating
      ? { aggregateRating: Number(meta.imdbRating) }
      : null,
    titleGenres: { genres: meta.genres.map((text) => ({ genre: { text } })) },
    plot: meta.description
      ? { plotText: { plainText: meta.description } }
      : null,
    primaryImage: meta.poster ? { url: meta.poster } : null,
    principalCredits: [
      ["director", meta.director ?? []] as const,
      ["cast", meta.cast ?? []] as const,
    ].map(([id, names]) => ({
      category: { id },
      credits: names.map((text) => ({ name: { nameText: { text } } })),
    })),
  };
}

type ImdbSource = StremioMeta[] | "private";

function stringOf(value: unknown) {
  return typeof value === "string" ? value : "";
}

function listOf(id: string, source: ImdbSource | undefined) {
  if (source === undefined) return null;
  const metas = source === "private" ? [] : source;
  return {
    id,
    visibility: { id: source === "private" ? "PRIVATE" : "PUBLIC" },
    titleListItemSearch: {
      total: metas.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: metas.map((meta) => ({ listItem: imdbTitle(meta) })),
    },
  };
}

/**
 * An IMDb GraphQL API in memory. It serves the watchlists, lists and titles
 * that a test stores, and keeps every request it receives.
 */
export class FakeImdb {
  readonly watchlists = new Map<string, ImdbSource>();
  readonly lists = new Map<string, ImdbSource>();
  readonly titles = new Map<string, StremioMeta>();
  readonly requests: ImdbRequest[] = [];

  /** The MSW handler of the IMDb GraphQL endpoint. */
  readonly handler = http.post(IMDB_GRAPHQL, ({ request }) =>
    this.answer(request),
  );

  reset() {
    this.watchlists.clear();
    this.lists.clear();
    this.titles.clear();
    this.requests.length = 0;
  }

  /** The requests with this operation name, for example `ListPage`. */
  requestsOf(operationName: string) {
    return this.requests.filter(
      (request) => request.operationName === operationName,
    );
  }

  /** The response to one request. A test handler can call it after a delay. */
  async answer(request: Request) {
    const { operationName, variables } = imdbRequest.parse(
      await request.json(),
    );
    this.requests.push({ operationName, variables });
    switch (operationName) {
      case "ValidateWatchlist":
      case "WatchListPage": {
        const userId = stringOf(variables.urConst);
        return HttpResponse.json({
          data: { predefinedList: listOf(userId, this.watchlists.get(userId)) },
        });
      }
      case "ValidateList":
      case "ListPage": {
        const listId = stringOf(variables.listId);
        return HttpResponse.json({
          data: { list: listOf(listId, this.lists.get(listId)) },
        });
      }
      case "TitlesById": {
        const ids = z.array(z.string()).parse(variables.ids);
        return HttpResponse.json({
          data: {
            titles: ids.map((id) => {
              const meta = this.titles.get(id);
              return meta ? imdbTitle(meta) : null;
            }),
          },
        });
      }
      default:
        return HttpResponse.json({
          errors: [{ message: `Unknown operation ${operationName}` }],
        });
    }
  }
}
