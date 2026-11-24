import { asImdbId } from "@stremlist/shared/constants";
import { z } from "zod";
import {
  justwatchQuery,
  justwatchRecheckStrategy,
} from "../titles/justwatch-lookup";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import { readPages } from "./paging";
import { SHARED_LIST_FRESHNESS_MS } from "./freshness";
import type { ProviderAdapter, SourceEntry } from "./types";
import { SourceUnavailableError } from "./types";

const LIST_ID = /^tl-[a-z]{2}-[0-9a-z-]+$/;

const COUNTRY = "US";
const LANGUAGE = "en";
const PAGE_SIZE = 200;
const MAX_ENTRIES = 2_000;

const LIST_QUERY = `
  query StremlistJustwatchList(
    $id: ID!
    $country: Country!
    $language: Language!
    $first: Int!
    $after: String
  ) {
    node(id: $id) {
      __typename
      ... on GenericTitleList {
        id
        type
        visibility
        name
        content(country: $country, language: $language) { name }
        titles(
          country: $country
          first: $first
          after: $after
          sortBy: NATURAL
          filter: { includeTitlesWithoutUrl: true }
        ) {
          totalCount
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              objectType
              content(country: $country, language: $language) {
                title
                originalReleaseYear
                externalIds { imdbId tmdbId }
              }
            }
          }
        }
      }
    }
  }
`;

const justwatchTitleNodeSchema = z.object({
  id: z.string(),
  objectType: z.string().nullish(),
  content: z
    .object({
      title: z.string().nullish(),
      originalReleaseYear: z.number().nullish(),
      externalIds: z
        .object({
          imdbId: z.string().nullish(),
          tmdbId: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
type JustwatchTitleNode = z.infer<typeof justwatchTitleNodeSchema>;

const justwatchListSchema = z.object({
  __typename: z.string().optional(),
  name: z.string().nullish(),
  content: z.object({ name: z.string().nullish() }).nullish(),
  titles: z
    .object({
      pageInfo: z
        .object({
          hasNextPage: z.boolean().optional(),
          endCursor: z.string().nullish(),
        })
        .optional(),
      edges: z
        .array(
          z.object({ node: justwatchTitleNodeSchema.nullish() }).nullable(),
        )
        .optional(),
    })
    .nullish(),
});
type JustwatchList = z.infer<typeof justwatchListSchema>;

const listPageSchema = z.object({ node: justwatchListSchema.nullish() });

async function fetchListPage(id: string, first: number, after: string | null) {
  const json = await justwatchQuery(
    LIST_QUERY,
    { id, country: COUNTRY, language: LANGUAGE, first, after },
    listPageSchema,
  );
  const node = json.data?.node;
  if (node?.__typename === "GenericTitleList" && node.titles) return node;

  const message = (json.errors ?? []).map((error) => error.message).join("; ");
  if (!node && /permission|unauthori[sz]ed|forbidden/i.test(message)) {
    throw new SourceUnavailableError(
      "private",
      "This JustWatch list is private",
    );
  }
  const isOtherNode = !!node && node.__typename !== "GenericTitleList";
  if (isOtherNode || (!node && (!message || /not ?found/i.test(message)))) {
    throw new SourceUnavailableError(
      "not_found",
      "This JustWatch list does not exist or was deleted",
    );
  }
  throw new Error(`JustWatch list query failed: ${message}`);
}

function toEntry(node: JustwatchTitleNode) {
  const type =
    node.objectType === "SHOW"
      ? "series"
      : node.objectType === "MOVIE"
        ? "movie"
        : undefined;
  const content = node.content ?? {};
  const tmdbId = Number(content.externalIds?.tmdbId);
  return {
    imdbId: asImdbId(content.externalIds?.imdbId),
    externalIds: {
      justwatch: node.id,
      tmdb:
        type && Number.isInteger(tmdbId) && tmdbId > 0
          ? { id: tmdbId, type }
          : undefined,
    },
    type,
    title: content.title ?? undefined,
    year: content.originalReleaseYear ?? undefined,
  } satisfies SourceEntry;
}

function listName(list: JustwatchList) {
  for (const name of [list.content?.name, list.name]) {
    const trimmed = name?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeRef(ref: string) {
  return ref.trim().toLowerCase();
}

/**
 * JustWatch: custom lists read anonymously through the unofficial GraphQL API
 * from their share link. Custom lists are UNLISTED (the server accepts no
 * other visibility today) and their random ID is the only secret, so no
 * Connection is needed. JustWatch's main watchlist needs the user's own
 * session token, so it is not supported (STR-18).
 *
 * The ToS forbid scraping: requests go through `justwatchLimiter`, and a
 * Catalog stays fresh for hours, not minutes.
 */
export const justwatchProvider: ProviderAdapter = {
  id: "justwatch",
  freshnessMs: SHARED_LIST_FRESHNESS_MS,

  async validateSource(rawRef) {
    const ref = normalizeRef(rawRef);
    if (!LIST_ID.test(ref)) return { ok: false, reason: "not_found" };
    const list = await fetchListPage(ref, 1, null);
    return {
      ok: true,
      ref,
      suggestedTitle: listName(list) ?? "JustWatch list",
      defaultDisplayMode: "split",
    };
  },

  async fetchSource(rawRef) {
    const ref = normalizeRef(rawRef);
    if (!LIST_ID.test(ref)) {
      throw new SourceUnavailableError(
        "not_found",
        "This is not a JustWatch list ID",
      );
    }
    const { items: nodes, complete } = await readPages({
      maxPages: Number.POSITIVE_INFINITY,
      maxItems: MAX_ENTRIES,
      first: null as string | null,
      async page(after, read) {
        const page = await fetchListPage(
          ref,
          Math.min(PAGE_SIZE, MAX_ENTRIES - read),
          after,
        );
        const pageInfo = page.titles?.pageInfo;
        return {
          items: (page.titles?.edges ?? []).flatMap((edge) =>
            edge?.node?.id ? [edge.node] : [],
          ),
          next:
            pageInfo?.hasNextPage && pageInfo.endCursor
              ? pageInfo.endCursor
              : null,
        };
      },
    });

    return { entries: nodes.map(toEntry), complete };
  },

  resolutionKey(entry) {
    const nodeId = entry.externalIds?.justwatch;
    return nodeId ? { namespace: "justwatch", externalId: nodeId } : null;
  },

  resolverStrategies: [tmdbExternalIdsStrategy, justwatchRecheckStrategy],
};
