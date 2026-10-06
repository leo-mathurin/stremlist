import type { GraphQLResponse } from "../providers/http";
import { graphqlRequest, RateLimiter } from "../providers/http";

/**
 * JustWatch's unofficial GraphQL API (no documentation, introspection off).
 * Shared by the JustWatch adapter and by the SensCritique ID resolution,
 * because SensCritique products can link to a JustWatch title.
 */
export const JUSTWATCH_GRAPHQL = "https://apis.justwatch.com/graphql";

// No published limits: stay gentle (ToS forbid scraping; see STR-18).
export const justwatchLimiter = new RateLimiter(5, 1000);

export function justwatchQuery<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  return graphqlRequest<T>(JUSTWATCH_GRAPHQL, query, variables, {
    limiter: justwatchLimiter,
  });
}

const IMDB_BY_PATH = `
  query StremlistTitleByPath($path: String!) {
    urlV2(fullPath: $path) {
      node {
        ... on MovieOrShow {
          content(country: FR, language: "fr") { externalIds { imdbId } }
        }
      }
    }
  }
`;

/**
 * IMDb ID of the JustWatch title at a site path such as "/fr/film/inception",
 * or null when JustWatch has none.
 */
export async function justwatchImdbIdByPath(
  path: string,
): Promise<string | null> {
  const json = await justwatchQuery<{
    urlV2?: {
      node?: { content?: { externalIds?: { imdbId?: string | null } } };
    } | null;
  }>(IMDB_BY_PATH, { path });
  const imdbId = json.data?.urlV2?.node?.content?.externalIds?.imdbId;
  return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null;
}

const IMDB_BY_NODE_IDS = `
  query StremlistTitlesByNodeIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on MovieOrShow {
        content(country: US, language: "en") { externalIds { imdbId } }
      }
    }
  }
`;

// One request per chunk keeps each call small; JustWatch has no batch limit
// that we know of.
const NODE_IDS_PER_REQUEST = 50;

/**
 * IMDb IDs of JustWatch title nodes ("tm…" for movies, "ts…" for shows), by
 * node ID. Nodes that JustWatch does not know, or that have no IMDb ID yet,
 * are left out. A node that cannot be read only nulls its own slot in the
 * response, so one bad ID does not hide the others.
 */
export async function justwatchImdbIdsByNodeIds(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += NODE_IDS_PER_REQUEST) {
    const json = await justwatchQuery<{
      nodes?: ({
        id?: string;
        content?: { externalIds?: { imdbId?: string | null } | null } | null;
      } | null)[];
    }>(IMDB_BY_NODE_IDS, {
      ids: unique.slice(start, start + NODE_IDS_PER_REQUEST),
    });
    for (const node of json.data?.nodes ?? []) {
      const imdbId = node?.content?.externalIds?.imdbId;
      if (node?.id && imdbId && /^tt\d+$/.test(imdbId)) {
        found.set(node.id, imdbId);
      }
    }
  }
  return found;
}
