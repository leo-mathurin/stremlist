import { asImdbId } from "@stremlist/shared/constants";
import { z } from "zod";
import { mapWithConcurrency } from "../lib/concurrency";
import { graphqlRequest, RateLimiter } from "../providers/http";
import type { ResolverStrategy } from "../providers/types";

const JUSTWATCH_GRAPHQL = "https://apis.justwatch.com/graphql";

const justwatchLimiter = new RateLimiter(5, 1000);

export function justwatchQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
) {
  return graphqlRequest(JUSTWATCH_GRAPHQL, query, variables, schema, {
    limiter: justwatchLimiter,
  });
}

const externalImdbIdSchema = z.object({ imdbId: z.string().nullish() });

const imdbByPathSchema = z.object({
  urlV2: z
    .object({
      node: z
        .object({
          content: z
            .object({ externalIds: externalImdbIdSchema.optional() })
            .optional(),
        })
        .optional(),
    })
    .nullish(),
});

const imdbByNodeIdsSchema = z.object({
  nodes: z
    .array(
      z
        .object({
          id: z.string().optional(),
          content: z
            .object({ externalIds: externalImdbIdSchema.nullish() })
            .nullish(),
        })
        .nullable(),
    )
    .optional(),
});

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

async function justwatchImdbIdByPath(path: string) {
  const json = await justwatchQuery(IMDB_BY_PATH, { path }, imdbByPathSchema);
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

const NODE_IDS_PER_REQUEST = 50;

async function justwatchImdbIdsByNodeIds(ids: readonly string[]) {
  const found = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += NODE_IDS_PER_REQUEST) {
    const json = await justwatchQuery(
      IMDB_BY_NODE_IDS,
      { ids: unique.slice(start, start + NODE_IDS_PER_REQUEST) },
      imdbByNodeIdsSchema,
    );
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
    const byNodeId = await justwatchImdbIdsByNodeIds(nodeIds);
    entries.forEach((entry, index) => {
      const nodeId = entry.externalIds?.justwatch;
      const imdbId = nodeId ? byNodeId.get(nodeId) : undefined;
      if (imdbId) found.set(index, imdbId);
    });
    return found;
  },
};
