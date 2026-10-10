import { asImdbId } from "@stremlist/shared/constants";
import { mapWithConcurrency } from "../lib/concurrency";
import type { GraphQLResponse } from "../providers/http";
import { graphqlRequest, RateLimiter } from "../providers/http";
import type { ResolverStrategy } from "../providers/types";

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
  return asImdbId(json.data?.urlV2?.node?.content?.externalIds?.imdbId) ?? null;
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
      const imdbId = asImdbId(node?.content?.externalIds?.imdbId);
      if (node?.id && imdbId) {
        found.set(node.id, imdbId);
      }
    }
  }
  return found;
}

const PATH_LOOKUP_CONCURRENCY = 3;

/**
 * Exact resolution through the JustWatch link that SensCritique shows on
 * products available to stream in France.
 */
export const justwatchPathStrategy: ResolverStrategy = {
  name: "justwatch-path",
  provider: "justwatch",
  async resolve(entries) {
    const found = new Map<number, string>();
    await mapWithConcurrency(
      entries,
      PATH_LOOKUP_CONCURRENCY,
      async (entry, index) => {
        const path = entry.externalIds?.justwatchPath;
        if (!path) return;
        try {
          const imdbId = await justwatchImdbIdByPath(path);
          if (imdbId) found.set(index, imdbId);
        } catch (error) {
          console.warn(
            `JustWatch lookup failed for ${path}:`,
            error instanceof Error ? error.message : error,
          );
        }
      },
    );
    return found;
  },
};

/**
 * JustWatch adds IMDb IDs to new releases days or weeks after the title
 * appears, so an entry that TMDB could not resolve is asked again on a later
 * refresh (the resolver retries Unresolved entries).
 */
export const justwatchRecheckStrategy: ResolverStrategy = {
  name: "justwatch-recheck",
  provider: "justwatch",
  async resolve(entries) {
    const found = new Map<number, string>();
    const nodeIds = entries.flatMap((entry) =>
      entry.externalIds?.justwatch ? [entry.externalIds.justwatch] : [],
    );
    if (nodeIds.length === 0) return found;
    const byNodeId = await justwatchImdbIdsByNodeIds(nodeIds);
    entries.forEach((entry, index) => {
      const nodeId = entry.externalIds?.justwatch;
      const imdbId = nodeId ? byNodeId.get(nodeId) : undefined;
      if (imdbId) found.set(index, imdbId);
    });
    return found;
  },
};
