import {
  justwatchImdbIdsByNodeIds,
  justwatchQuery,
} from "../titles/justwatch-lookup";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import type {
  ProviderAdapter,
  ResolverStrategy,
  SourceEntry,
  SourceValidation,
} from "./types";
import { SourceUnavailableError } from "./types";

/**
 * List IDs look like "tl-us-<uuid>" for custom lists and "tl-pa-<uuid>" for
 * JustWatch's public lists. The two letters are not a country.
 */
const LIST_ID = /^tl-[a-z]{2}-[0-9a-z-]+$/;

/**
 * `titles(country:)` hides the titles that have no page in that country (a
 * public list had 101 titles in the US, 77 in FR, 59 in JP). With
 * `includeTitlesWithoutUrl` every country returns the same titles in the same
 * order, so the country only selects which localized content we read.
 */
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

interface JustwatchTitleNode {
  id: string;
  objectType?: string | null;
  content?: {
    title?: string | null;
    originalReleaseYear?: number | null;
    externalIds?: { imdbId?: string | null; tmdbId?: string | null } | null;
  } | null;
}

interface JustwatchList {
  __typename?: string;
  id?: string;
  /** USER_LIST for custom lists; PERMANENT_AUDIENCE_LIST, TECHNICAL_USER_LIST for JustWatch's own. */
  type?: string | null;
  visibility?: string | null;
  name?: string | null;
  content?: { name?: string | null } | null;
  titles?: {
    totalCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    edges?: ({ node?: JustwatchTitleNode | null } | null)[];
  } | null;
}

async function fetchListPage(
  id: string,
  first: number,
  after: string | null,
): Promise<JustwatchList> {
  const json = await justwatchQuery<{ node?: JustwatchList | null }>(
    LIST_QUERY,
    { id, country: COUNTRY, language: LANGUAGE, first, after },
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
  // A deleted list or a bad ID gives `node: null` with a gRPC NotFound. Any
  // other error (for example a schema change) is a real failure, so it must
  // not look like a deleted list.
  const isOtherNode = !!node && node.__typename !== "GenericTitleList";
  if (isOtherNode || (!node && (!message || /not ?found/i.test(message)))) {
    throw new SourceUnavailableError(
      "not_found",
      "This JustWatch list does not exist or was deleted",
    );
  }
  throw new Error(`JustWatch list query failed: ${message}`);
}

function toEntry(node: JustwatchTitleNode): SourceEntry {
  const type =
    node.objectType === "SHOW"
      ? "series"
      : node.objectType === "MOVIE"
        ? "movie"
        : undefined;
  const content = node.content ?? {};
  const imdbId = content.externalIds?.imdbId;
  const tmdbId = Number(content.externalIds?.tmdbId);
  return {
    imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined,
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
  };
}

function listName(list: JustwatchList): string | undefined {
  // Public lists keep their name in `content`; the top-level field is "".
  for (const name of [list.content?.name, list.name]) {
    const trimmed = name?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

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
  freshnessMs: 6 * 60 * 60_000,

  async validateSource(rawRef): Promise<SourceValidation> {
    const ref = normalizeRef(rawRef);
    if (!LIST_ID.test(ref)) return { ok: false, reason: "not_found" };
    try {
      const list = await fetchListPage(ref, 1, null);
      return {
        ok: true,
        ref,
        suggestedTitle: listName(list) ?? "JustWatch list",
        defaultDisplayMode: "split",
      };
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        return { ok: false, reason: error.reason, message: error.message };
      }
      throw error;
    }
  },

  async fetchSource(rawRef) {
    const ref = normalizeRef(rawRef);
    if (!LIST_ID.test(ref)) {
      throw new SourceUnavailableError(
        "not_found",
        "This is not a JustWatch list ID",
      );
    }
    const nodes: JustwatchTitleNode[] = [];
    let after: string | null = null;
    while (nodes.length < MAX_ENTRIES) {
      const page = await fetchListPage(
        ref,
        Math.min(PAGE_SIZE, MAX_ENTRIES - nodes.length),
        after,
      );
      for (const edge of page.titles?.edges ?? []) {
        if (edge?.node?.id) nodes.push(edge.node);
      }
      const pageInfo = page.titles?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }

    // Custom lists come oldest added first, the canonical order (checked on a
    // real list on 2026-10-06); JustWatch's own lists keep their curated order.
    return { entries: nodes.map(toEntry) };
  },

  resolutionKey(entry) {
    const nodeId = entry.externalIds?.justwatch;
    return nodeId ? { namespace: "justwatch", externalId: nodeId } : null;
  },

  resolverStrategies: [tmdbExternalIdsStrategy, justwatchRecheckStrategy],
};
