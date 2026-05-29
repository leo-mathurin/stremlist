import {
  DEFAULT_SORT_OPTIONS,
  FACEBOOK_EXTERNAL_HIT_USER_AGENT,
} from "@stremlist/shared";
import type {
  SortOptions,
  StremioMeta,
  WatchlistData,
} from "@stremlist/shared";
import { shuffleArray } from "../utils";

const GRAPHQL_ENDPOINT = "https://api.graphql.imdb.com/";
const GRAPHQL_CLIENT_NAME = "imdb-next-desktop";

// IMDb's GraphQL rejects the full-metadata query with "Too much data
// requested" once `first` reaches ~1000. 250 stays comfortably under that and
// matches the cursor index IMDb itself uses on imdb.com.
const PAGE_SIZE = 250;
// Safety stop for runaway pagination loops.
const MAX_PAGES = 40;

const WATCHLIST_QUERY = `
  query WatchListPage($urConst: ID!, $first: Int!, $after: String) {
    predefinedList(classType: WATCH_LIST, userId: $urConst) {
      id
      visibility { id }
      titleListItemSearch(first: $first, after: $after) {
        total
        pageInfo { hasNextPage endCursor }
        edges {
          listItem: title {
            id
            titleText { text }
            titleType { text }
            releaseYear { year }
            ratingsSummary { aggregateRating }
            titleGenres { genres { genre { text } } }
            plot { plotText { plainText } }
            primaryImage { url }
            runtime { seconds }
            principalCredits {
              category { id }
              credits(limit: 5) {
                name { nameText { text } }
              }
            }
          }
        }
      }
    }
  }
`;

const LIST_QUERY = `
  query ListPage($listId: ID!, $first: Int!, $after: String) {
    list(id: $listId) {
      id
      name { originalText }
      visibility { id }
      titleListItemSearch(first: $first, after: $after) {
        total
        pageInfo { hasNextPage endCursor }
        edges {
          listItem: title {
            id
            titleText { text }
            titleType { text }
            releaseYear { year }
            ratingsSummary { aggregateRating }
            titleGenres { genres { genre { text } } }
            plot { plotText { plainText } }
            primaryImage { url }
            runtime { seconds }
            principalCredits {
              category { id }
              credits(limit: 5) {
                name { nameText { text } }
              }
            }
          }
        }
      }
    }
  }
`;

const VALIDATE_LIST_QUERY = `
  query ValidateList($listId: ID!) {
    list(id: $listId) {
      id
      visibility { id }
    }
  }
`;

interface ImdbEdge {
  listItem: {
    id: string;
    titleText?: { text: string };
    titleType?: { text: string };
    releaseYear?: { year: number };
    ratingsSummary?: { aggregateRating: number };
    titleGenres?: {
      genres: { genre?: { text: string } }[];
    };
    plot?: { plotText?: { plainText: string } };
    primaryImage?: { url: string };
    runtime?: { seconds: number };
    principalCredits?: {
      category?: { id: string };
      credits?: {
        name?: { nameText?: { text: string } };
      }[];
    }[];
  };
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface TitleListItemSearch {
  total: number;
  pageInfo?: PageInfo;
  edges?: ImdbEdge[];
}

interface GraphQLResponse {
  data?: {
    predefinedList?: {
      id: string;
      visibility?: { id: string };
      titleListItemSearch?: TitleListItemSearch;
    } | null;
    list?: {
      id: string;
      name?: { originalText: string };
      visibility?: { id: string };
      titleListItemSearch?: TitleListItemSearch;
    } | null;
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

interface ProcessedItem {
  id: string;
  title: string | null;
  type: string | null;
  year: number | null;
  rating: number | null;
  genres: string[];
  plot: string | null;
  image_url: string | null;
  runtime_seconds: number | null;
  directors: string[];
  cast: string[];
}

export const ERROR_NOT_FOUND =
  "Could not find an IMDb watchlist for this ID. Please check and try again.";
export const ERROR_PRIVATE =
  "This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.";

export const ERROR_LIST_NOT_FOUND =
  "Could not find an IMDb list for this ID. Please check and try again.";
export const ERROR_LIST_PRIVATE =
  "This IMDb list is private. Please ask the list owner to make it public.";

export type WatchlistErrorReason = "private" | "not_found";

/**
 * Classify a thrown fetch error as an expected user-state (private list /
 * not-found) vs. something else (transient/unknown → null). Kept next to the
 * message constants so the mapping has a single source of truth.
 */
export function classifyWatchlistError(
  error: unknown,
): WatchlistErrorReason | null {
  const message = error instanceof Error ? error.message : "";
  if (message === ERROR_PRIVATE || message === ERROR_LIST_PRIVATE) {
    return "private";
  }
  if (message === ERROR_NOT_FOUND || message === ERROR_LIST_NOT_FOUND) {
    return "not_found";
  }
  return null;
}

function hasForbiddenError(errors: GraphQLResponse["errors"]): boolean {
  return errors?.some((e) => e.extensions?.code === "FORBIDDEN") ?? false;
}

async function queryImdbGraphQL(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-imdb-client-name": GRAPHQL_CLIENT_NAME,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  if (!response.ok) {
    throw new Error(ERROR_NOT_FOUND);
  }

  return (await response.json()) as GraphQLResponse;
}

export function buildPosterUrl(
  imdbId: string,
  fallbackPosterUrl: string | null,
  rpdbApiKey?: string | null,
): string | null {
  const normalizedKey = rpdbApiKey?.trim();
  if (!normalizedKey) {
    return fallbackPosterUrl;
  }

  return `https://api.ratingposterdb.com/${encodeURIComponent(normalizedKey)}/imdb/poster-default/${imdbId}.jpg?fallback=true`;
}

export type ValidationResult =
  | { valid: true; userId: string }
  | { valid: false; reason: "not_found" | "private" };

export type ListValidationResult =
  | { valid: true }
  | { valid: false; reason: "not_found" | "private" };

const pHandleCache = new Map<string, string>();

async function resolvePHandle(handle: string): Promise<string> {
  const cached = pHandleCache.get(handle);
  if (cached) {
    return cached;
  }

  const response = await fetch(`https://www.imdb.com/user/${handle}/`, {
    headers: { "User-Agent": FACEBOOK_EXTERNAL_HIT_USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(ERROR_NOT_FOUND);
  }

  const body = await response.text();
  const match = /"userId":"(ur\d+)"/.exec(body);
  if (!match) {
    throw new Error(ERROR_NOT_FOUND);
  }

  const canonical = match[1];
  pHandleCache.set(handle, canonical);
  return canonical;
}

export async function normalizeImdbUserId(input: string): Promise<string> {
  if (!input.startsWith("p.")) {
    return input;
  }
  return resolvePHandle(input);
}

const VALIDATE_QUERY = `
  query ValidateWatchlist($urConst: ID!) {
    predefinedList(classType: WATCH_LIST, userId: $urConst) {
      id
      visibility { id }
    }
  }
`;

export async function validateImdbWatchlist(
  input: string,
): Promise<ValidationResult> {
  let userId: string;
  try {
    userId = await normalizeImdbUserId(input);
  } catch {
    return { valid: false, reason: "not_found" };
  }

  try {
    const json = await queryImdbGraphQL("ValidateWatchlist", VALIDATE_QUERY, {
      urConst: userId,
    });

    if (json.errors?.length) {
      return {
        valid: false,
        reason: hasForbiddenError(json.errors) ? "private" : "not_found",
      };
    }

    const list = json.data?.predefinedList;
    if (!list) {
      return { valid: false, reason: "not_found" };
    }

    if (list.visibility?.id === "PUBLIC") {
      return { valid: true, userId };
    }

    return { valid: false, reason: "private" };
  } catch {
    return { valid: false, reason: "not_found" };
  }
}

export async function getImdbWatchlist(input: string): Promise<ImdbEdge[]> {
  const userId = await normalizeImdbUserId(input);
  const edges: ImdbEdge[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await queryImdbGraphQL("WatchListPage", WATCHLIST_QUERY, {
      urConst: userId,
      first: PAGE_SIZE,
      after,
    });

    if (json.errors?.length) {
      throw new Error(
        hasForbiddenError(json.errors) ? ERROR_PRIVATE : ERROR_NOT_FOUND,
      );
    }

    const list = json.data?.predefinedList;

    if (!list) {
      throw new Error(ERROR_NOT_FOUND);
    }

    if (list.visibility?.id === "PRIVATE") {
      throw new Error(ERROR_PRIVATE);
    }

    const search = list.titleListItemSearch;
    edges.push(...(search?.edges ?? []));

    const pageInfo = search?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
      break;
    }
    after = pageInfo.endCursor;

    if (page === MAX_PAGES - 1) {
      console.warn(
        `Watchlist for ${userId} hit MAX_PAGES (${MAX_PAGES} × ${PAGE_SIZE} = ${MAX_PAGES * PAGE_SIZE}); remaining items truncated.`,
      );
    }
  }

  return edges;
}

function processWatchlist(edges: ImdbEdge[]): ProcessedItem[] {
  const items: ProcessedItem[] = [];

  for (const edge of edges) {
    const movieData = edge.listItem;

    const item: ProcessedItem = {
      id: movieData.id,
      title: movieData.titleText?.text ?? null,
      type: movieData.titleType?.text ?? null,
      year: movieData.releaseYear?.year ?? null,
      rating: movieData.ratingsSummary?.aggregateRating ?? null,
      genres: [],
      plot: movieData.plot?.plotText?.plainText ?? null,
      image_url: movieData.primaryImage?.url ?? null,
      runtime_seconds: movieData.runtime?.seconds ?? null,
      directors: [],
      cast: [],
    };

    if (movieData.titleGenres?.genres) {
      for (const g of movieData.titleGenres.genres) {
        const text = g.genre?.text;
        if (text) {
          item.genres.push(text);
        }
      }
    }

    if (movieData.principalCredits) {
      for (const group of movieData.principalCredits) {
        const categoryId = group.category?.id;
        if (!categoryId) {
          continue;
        }

        for (const credit of group.credits ?? []) {
          const name = credit.name?.nameText?.text;
          if (!name) {
            continue;
          }

          if (categoryId === "director") {
            item.directors.push(name);
          } else if (categoryId === "cast") {
            item.cast.push(name);
          }
        }
      }
    }

    items.push(item);
  }

  return items;
}

function formatRuntime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function sortMetas(metas: StremioMeta[], options: SortOptions): StremioMeta[] {
  const sorted = [...metas];
  const { by, order } = options;
  const multiplier = order === "desc" ? -1 : 1;

  if (by === "added_at") {
    if (order === "desc") {
      sorted.reverse();
    }
    return sorted;
  }

  if (by === "random") {
    return shuffleArray(sorted);
  }

  sorted.sort((a, b) => {
    switch (by) {
      case "year": {
        const ya = a.releaseInfo ? parseInt(a.releaseInfo, 10) || 0 : 0;
        const yb = b.releaseInfo ? parseInt(b.releaseInfo, 10) || 0 : 0;
        return (ya - yb) * multiplier;
      }
      case "rating": {
        const ra = a.imdbRating ? parseFloat(a.imdbRating) || 0 : 0;
        const rb = b.imdbRating ? parseFloat(b.imdbRating) || 0 : 0;
        return (ra - rb) * multiplier;
      }
      case "title":
      default:
        return a.name.localeCompare(b.name) * multiplier;
    }
  });

  return sorted;
}

// Stremio only has `movie` and `series` catalog types, so every single-video
// IMDb title (theatrical, made-for-TV, short, etc.) maps to `movie`. Episodic
// content (`TV Episode`) and non-video titles (`Video Game`, `Music Video`,
// `Podcast Series`, `Podcast Episode`) are dropped.
const MOVIE_TYPES = new Set([
  "Movie",
  "TV Movie",
  "TV Special",
  "Short",
  "TV Short",
  "Video",
]);
const SERIES_TYPES = new Set(["TV Series", "TV Mini Series"]);

function convertToStremioFormat(
  items: ProcessedItem[],
  sortOptions: SortOptions,
  rpdbApiKey?: string | null,
): StremioMeta[] {
  const metas: StremioMeta[] = [];

  for (const item of items) {
    if (!item.id) {
      continue;
    }

    const isMovie = item.type != null && MOVIE_TYPES.has(item.type);
    const isSeries = item.type != null && SERIES_TYPES.has(item.type);
    if (!isMovie && !isSeries) {
      continue;
    }

    const meta: StremioMeta = {
      id: item.id,
      name: item.title ?? "",
      poster: buildPosterUrl(item.id, item.image_url, rpdbApiKey),
      posterShape: "poster",
      type: isMovie ? "movie" : "series",
      genres: item.genres,
      description: item.plot ?? "",
    };

    if (item.rating != null) {
      meta.imdbRating = item.rating.toString();
    }
    if (item.year != null) {
      meta.releaseInfo = item.year.toString();
    }
    if (item.directors.length > 0) {
      meta.director = item.directors;
    }
    if (item.cast.length > 0) {
      meta.cast = item.cast;
    }
    if (item.runtime_seconds != null) {
      meta.runtime = formatRuntime(item.runtime_seconds);
    }

    metas.push(meta);
  }

  return sortMetas(metas, sortOptions);
}

export function isListId(id: string): boolean {
  return id.startsWith("ls");
}

export async function fetchWatchlist(
  imdbUserId: string,
  sortOptions: SortOptions = DEFAULT_SORT_OPTIONS,
  rpdbApiKey?: string | null,
): Promise<WatchlistData> {
  console.log(`Fetching IMDb watchlist for user ${imdbUserId}...`);

  const edges = await getImdbWatchlist(imdbUserId);

  console.log(
    `Raw watchlist data received from IMDb for user ${imdbUserId} (${edges.length} items)`,
  );

  const processed = processWatchlist(edges);
  const metas = convertToStremioFormat(processed, sortOptions, rpdbApiKey);
  console.log(
    `Converted ${metas.length} items to Stremio format (sorted by ${sortOptions.by}, ${sortOptions.order})`,
  );

  return { metas };
}

export async function validateImdbList(
  listId: string,
): Promise<ListValidationResult> {
  try {
    const json = await queryImdbGraphQL("ValidateList", VALIDATE_LIST_QUERY, {
      listId,
    });

    if (json.errors?.length) {
      return {
        valid: false,
        reason: hasForbiddenError(json.errors) ? "private" : "not_found",
      };
    }

    const list = json.data?.list;
    if (!list) {
      return { valid: false, reason: "not_found" };
    }

    if (list.visibility?.id === "PUBLIC") {
      return { valid: true };
    }

    return { valid: false, reason: "private" };
  } catch {
    return { valid: false, reason: "not_found" };
  }
}

export async function getImdbList(listId: string): Promise<ImdbEdge[]> {
  const edges: ImdbEdge[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await queryImdbGraphQL("ListPage", LIST_QUERY, {
      listId,
      first: PAGE_SIZE,
      after,
    });

    if (json.errors?.length) {
      throw new Error(
        hasForbiddenError(json.errors)
          ? ERROR_LIST_PRIVATE
          : ERROR_LIST_NOT_FOUND,
      );
    }

    const list = json.data?.list;

    if (!list) {
      throw new Error(ERROR_LIST_NOT_FOUND);
    }

    if (list.visibility?.id === "PRIVATE") {
      throw new Error(ERROR_LIST_PRIVATE);
    }

    const search = list.titleListItemSearch;
    edges.push(...(search?.edges ?? []));

    const pageInfo = search?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
      break;
    }
    after = pageInfo.endCursor;

    if (page === MAX_PAGES - 1) {
      console.warn(
        `List ${listId} hit MAX_PAGES (${MAX_PAGES} × ${PAGE_SIZE} = ${MAX_PAGES * PAGE_SIZE}); remaining items truncated.`,
      );
    }
  }

  return edges;
}

export async function fetchList(
  listId: string,
  sortOptions: SortOptions = DEFAULT_SORT_OPTIONS,
  rpdbApiKey?: string | null,
): Promise<WatchlistData> {
  console.log(`Fetching IMDb list ${listId}...`);

  const edges = await getImdbList(listId);

  console.log(
    `Raw list data received from IMDb for ${listId} (${edges.length} items)`,
  );

  const processed = processWatchlist(edges);
  const metas = convertToStremioFormat(processed, sortOptions, rpdbApiKey);
  console.log(
    `Converted ${metas.length} items to Stremio format (sorted by ${sortOptions.by}, ${sortOptions.order})`,
  );

  return { metas };
}
