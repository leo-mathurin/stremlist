import { DEFAULT_SORT_OPTIONS } from "@stremlist/shared";
import type {
  SortOptions,
  StremioMeta,
  WatchlistData,
} from "@stremlist/shared";
import { shuffleArray } from "../utils";

const GRAPHQL_ENDPOINT = "https://api.graphql.imdb.com/";
const GRAPHQL_CLIENT_NAME = "imdb-next-desktop";

const WATCHLIST_QUERY = `
  query WatchListPage($urConst: ID!, $first: Int!) {
    predefinedList(classType: WATCH_LIST, userId: $urConst) {
      id
      visibility { id }
      titleListItemSearch(first: $first) {
        total
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

interface GraphQLResponse {
  data?: {
    predefinedList?: {
      id: string;
      visibility?: { id: string };
      titleListItemSearch?: {
        total: number;
        edges?: ImdbEdge[];
      };
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

const ERROR_NOT_FOUND =
  "Could not find an IMDb watchlist for this ID. Please check and try again.";
const ERROR_PRIVATE =
  "This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.";

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
  | { valid: true }
  | { valid: false; reason: "not_found" | "private" };

const VALIDATE_QUERY = `
  query ValidateWatchlist($urConst: ID!) {
    predefinedList(classType: WATCH_LIST, userId: $urConst) {
      id
      visibility { id }
    }
  }
`;

export async function validateImdbWatchlist(
  userId: string,
): Promise<ValidationResult> {
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
      return { valid: true };
    }

    return { valid: false, reason: "private" };
  } catch {
    return { valid: false, reason: "not_found" };
  }
}

export async function getImdbWatchlist(userId: string): Promise<ImdbEdge[]> {
  const json = await queryImdbGraphQL("WatchListPage", WATCHLIST_QUERY, {
    urConst: userId,
    first: 5000,
  });

  if (json.errors?.length) {
    throw new Error(hasForbiddenError(json.errors) ? ERROR_PRIVATE : ERROR_NOT_FOUND);
  }

  const list = json.data?.predefinedList;

  if (!list) {
    throw new Error(ERROR_NOT_FOUND);
  }

  if (list.visibility?.id === "PRIVATE") {
    throw new Error(ERROR_PRIVATE);
  }

  return list.titleListItemSearch?.edges ?? [];
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

    const isMovie = item.type === "Movie";
    const isSeries =
      item.type === "TV Series" || item.type === "TV Mini Series";
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
  if (processed.length === 0) {
    throw new Error(
      "This watchlist appears to be empty or may not contain any compatible movies or series.",
    );
  }

  const metas = convertToStremioFormat(processed, sortOptions, rpdbApiKey);
  console.log(
    `Converted ${metas.length} items to Stremio format (sorted by ${sortOptions.by}, ${sortOptions.order})`,
  );

  if (metas.length === 0) {
    throw new Error(
      "This watchlist appears to be empty or may not contain any compatible movies or series.",
    );
  }

  return { metas };
}
