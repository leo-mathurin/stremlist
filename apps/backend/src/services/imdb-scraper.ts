import {
  FACEBOOK_EXTERNAL_HIT_USER_AGENT,
  IMDB_RATINGS_REF_PATTERN,
} from "@stremlist/shared/constants";
import { CHART_BY_ID, isChartId } from "@stremlist/shared/imdb-charts";
import type { ChartEntry } from "@stremlist/shared/imdb-charts";
import type { StremioMeta, CatalogData } from "@stremlist/shared/stremio.types";
import { z } from "zod";
import { HttpError } from "../providers/http";

const GRAPHQL_ENDPOINT = "https://api.graphql.imdb.com/";
const GRAPHQL_CLIENT_NAME = "imdb-next-desktop";

const PAGE_SIZE = 750;
const IMDB_CURSOR_WINDOW_SIZE = 10_000;
const MAX_ITEMS = 15_000;
const MAX_RATINGS = IMDB_CURSOR_WINDOW_SIZE;

function pagesFor(maxItems: number) {
  return (
    Math.floor(maxItems / IMDB_CURSOR_WINDOW_SIZE) *
      Math.ceil(IMDB_CURSOR_WINDOW_SIZE / PAGE_SIZE) +
    Math.ceil((maxItems % IMDB_CURSOR_WINDOW_SIZE) / PAGE_SIZE)
  );
}

function getPageSize(itemsFetched: number, targetItems: number) {
  const remaining = targetItems - itemsFetched;
  const cursorWindowRemaining =
    IMDB_CURSOR_WINDOW_SIZE - (itemsFetched % IMDB_CURSOR_WINDOW_SIZE);
  return Math.min(PAGE_SIZE, remaining, cursorWindowRemaining);
}

const TITLE_FRAGMENT = `
  id
  titleText { text }
  titleType { text }
  releaseYear { year }
  releaseDate { year month day }
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
`;

const WATCHLIST_QUERY = `
  query WatchListPage($urConst: ID!, $first: Int!, $after: String) {
    predefinedList(classType: WATCH_LIST, userId: $urConst) {
      id
      visibility { id }
      titleListItemSearch(first: $first, after: $after) {
        total
        pageInfo { hasNextPage endCursor }
        edges {
          node { createdDate }
          listItem: title { ${TITLE_FRAGMENT} }
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
          node { createdDate }
          listItem: title { ${TITLE_FRAGMENT} }
        }
      }
    }
  }
`;

const RATINGS_QUERY = `
  query UserRatings($userId: ID!, $first: Int!, $after: String) {
    advancedTitleSearch(
      first: $first
      after: $after
      constraints: {
        singleUserRatingConstraint: { filterType: INCLUDE, userId: $userId }
      }
      sort: { sortBy: SINGLE_USER_RATING_DATE, sortOrder: DESC }
    ) {
      total
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title {
            ${TITLE_FRAGMENT}
            userRating(userId: $userId) { date }
          }
        }
      }
    }
  }
`;

const VALIDATE_RATINGS_QUERY = `
  query ValidateRatings($userId: ID!) {
    advancedTitleSearch(
      first: 1
      constraints: {
        singleUserRatingConstraint: { filterType: INCLUDE, userId: $userId }
      }
    ) {
      total
    }
  }
`;

function buildChartTitlesQuery(chartType: string) {
  return `
    query ChartTitles($first: Int!, $after: String) {
      chartTitles(chart: { chartType: ${chartType} }, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node { ${TITLE_FRAGMENT} }
        }
      }
    }
  `;
}

const BOX_OFFICE_QUERY = `
  query BoxOffice {
    topGrossingReleases(
      first: 10
      filter: {
        timeWindow: { timeWindowPeriod: LATEST_WEEKEND }
        topGrossingReleasesArea: { boxOfficeArea: "XDOM" }
      }
    ) {
      edges {
        node {
          release {
            titles { ${TITLE_FRAGMENT} }
          }
        }
      }
    }
  }
`;

function buildComingSoonQuery(comingSoonType: string, date: string) {
  return `
    query ComingSoon($first: Int!) {
      comingSoon(
        comingSoonType: ${comingSoonType}
        releasingOnOrAfter: "${date}"
        first: $first
      ) {
        edges {
          node { ${TITLE_FRAGMENT} }
        }
      }
    }
  `;
}

const VALIDATE_LIST_QUERY = `
  query ValidateList($listId: ID!) {
    list(id: $listId) {
      id
      visibility { id }
    }
  }
`;

const textSchema = z.object({ text: z.string().nullish() }).nullish();

const titleNodeSchema = z.object({
  id: z.string(),
  titleText: textSchema,
  titleType: textSchema,
  releaseYear: z.object({ year: z.number().nullish() }).nullish(),
  releaseDate: z
    .object({
      year: z.number().nullish(),
      month: z.number().nullish(),
      day: z.number().nullish(),
    })
    .nullish(),
  ratingsSummary: z.object({ aggregateRating: z.number().nullish() }).nullish(),
  titleGenres: z
    .object({
      genres: z.array(z.object({ genre: textSchema })).nullish(),
    })
    .nullish(),
  plot: z
    .object({
      plotText: z.object({ plainText: z.string().nullish() }).nullish(),
    })
    .nullish(),
  primaryImage: z.object({ url: z.string().nullish() }).nullish(),
  runtime: z.object({ seconds: z.number().nullish() }).nullish(),
  principalCredits: z
    .array(
      z.object({
        category: z.object({ id: z.string().nullish() }).nullish(),
        credits: z
          .array(
            z.object({
              name: z.object({ nameText: textSchema }).nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
});
type TitleNode = z.infer<typeof titleNodeSchema>;

const imdbEdgeSchema = z.object({
  node: z.object({ createdDate: z.string().nullish() }).nullish(),
  listItem: titleNodeSchema,
});
type ImdbEdge = z.infer<typeof imdbEdgeSchema>;

const pageInfoSchema = z.object({
  hasNextPage: z.boolean().nullish(),
  endCursor: z.string().nullish(),
});

const titleListItemSearchSchema = z.object({
  total: z.number().nullish(),
  pageInfo: pageInfoSchema.nullish(),
  edges: z.array(imdbEdgeSchema).nullish(),
});

const imdbListSchema = z.object({
  id: z.string().nullish(),
  name: z.object({ originalText: z.string().nullish() }).nullish(),
  visibility: z.object({ id: z.string().nullish() }).nullish(),
  titleListItemSearch: titleListItemSearchSchema.nullish(),
});

const ratedTitleSchema = titleNodeSchema.extend({
  userRating: z.object({ date: z.string().nullish() }).nullish(),
});

const graphqlResponseSchema = z.object({
  data: z
    .object({
      predefinedList: imdbListSchema.nullish(),
      list: imdbListSchema.nullish(),
      advancedTitleSearch: z
        .object({
          total: z.number().nullish(),
          pageInfo: pageInfoSchema.nullish(),
          edges: z
            .array(
              z.object({
                node: z.object({ title: ratedTitleSchema.nullish() }).nullish(),
              }),
            )
            .nullish(),
        })
        .nullish(),
      chartTitles: z
        .object({
          pageInfo: pageInfoSchema.nullish(),
          edges: z.array(z.object({ node: titleNodeSchema })).nullish(),
        })
        .nullish(),
      topGrossingReleases: z
        .object({
          edges: z
            .array(
              z.object({
                node: z.object({
                  release: z
                    .object({ titles: z.array(titleNodeSchema).nullish() })
                    .nullish(),
                }),
              }),
            )
            .nullish(),
        })
        .nullish(),
      comingSoon: z
        .object({
          edges: z.array(z.object({ node: titleNodeSchema })).nullish(),
        })
        .nullish(),
      titles: z.array(titleNodeSchema.nullable()).nullish(),
    })
    .nullish(),
  errors: z
    .array(
      z.object({
        message: z.string().nullish(),
        extensions: z.object({ code: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});
type GraphQLResponse = z.infer<typeof graphqlResponseSchema>;

interface ProcessedItem {
  id: string;
  title: string | null;
  type: string | null;
  year: number | null;
  released?: string;
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

const ERROR_LIST_NOT_FOUND =
  "Could not find an IMDb list for this ID. Please check and try again.";
const ERROR_LIST_PRIVATE =
  "This IMDb list is private. Please ask the list owner to make it public.";

const ERROR_RATINGS_NOT_FOUND =
  "Could not find the IMDb ratings of this user. Please check and try again.";
const ERROR_RATINGS_PRIVATE =
  "These IMDb ratings are private. Please make your ratings public in your IMDb settings.";

export type WatchlistErrorReason = "private" | "not_found";

/**
 * Classify a thrown fetch error as an expected user-state (private list /
 * not-found) vs. something else (transient/unknown → null). Kept next to the
 * message constants so the mapping has a single source of truth.
 */
export function classifyImdbError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (
    message === ERROR_PRIVATE ||
    message === ERROR_LIST_PRIVATE ||
    message === ERROR_RATINGS_PRIVATE
  ) {
    return "private";
  }
  if (
    message === ERROR_NOT_FOUND ||
    message === ERROR_LIST_NOT_FOUND ||
    message === ERROR_RATINGS_NOT_FOUND
  ) {
    return "not_found";
  }
  return null;
}

function hasForbiddenError(errors: GraphQLResponse["errors"]) {
  return errors?.some((e) => e.extensions?.code === "FORBIDDEN") ?? false;
}

async function queryImdbGraphQL(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-imdb-client-name": GRAPHQL_CLIENT_NAME,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  if (response.status >= 500) {
    throw new HttpError(response.status, "", GRAPHQL_ENDPOINT);
  }
  if (!response.ok) {
    throw new Error(ERROR_NOT_FOUND);
  }

  return graphqlResponseSchema.parse(await response.json());
}

export type ValidationResult =
  | { valid: true; userId: string }
  | { valid: false; reason: "not_found" | "private" };

export type ListValidationResult =
  | { valid: true }
  | { valid: false; reason: "not_found" | "private" };

const pHandleCache = new Map<string, string>();

async function resolvePHandle(handle: string) {
  const cached = pHandleCache.get(handle);
  if (cached) {
    return cached;
  }

  const response = await fetch(`https://www.imdb.com/user/${handle}/`, {
    headers: { "User-Agent": FACEBOOK_EXTERNAL_HIT_USER_AGENT },
  });

  if (response.status >= 500) {
    throw new HttpError(
      response.status,
      "",
      response.url || "https://www.imdb.com/",
    );
  }
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

export async function normalizeImdbUserId(input: string) {
  if (isChartId(input)) {
    return input;
  }
  const ratings = IMDB_RATINGS_REF_PATTERN.exec(input);
  if (ratings) {
    return `${await normalizeImdbUserId(ratings[1])}/ratings`;
  }
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

type ImdbList = z.infer<typeof imdbListSchema> | null | undefined;

function validationResult(json: GraphQLResponse, list: ImdbList) {
  if (json.errors?.length) {
    return {
      valid: false,
      reason: hasForbiddenError(json.errors) ? "private" : "not_found",
    };
  }
  if (!list) return { valid: false, reason: "not_found" };
  return list.visibility?.id === "PUBLIC"
    ? { valid: true }
    : { valid: false, reason: "private" };
}

export async function validateImdbWatchlist(input: string) {
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
    const result = validationResult(json, json.data?.predefinedList);
    return result.valid ? { valid: true, userId } : result;
  } catch {
    return { valid: false, reason: "not_found" };
  }
}

async function readListPages(
  label: string,
  errors: { private: string; notFound: string },
  readPage: (
    first: number,
    after: string | null,
  ) => Promise<{ json: GraphQLResponse; list: ImdbList }>,
  maxItems = MAX_ITEMS,
) {
  const edges: ImdbEdge[] = [];
  let after: string | null = null;
  let targetItems = maxItems;
  let complete = true;
  const truncate = () => {
    complete = false;
    console.warn(
      `${label} exceeded the ${maxItems.toLocaleString("en-US")}-item limit; remaining items truncated.`,
    );
  };

  const maxPages = pagesFor(maxItems);
  for (let page = 0; page < maxPages; page++) {
    const first = getPageSize(edges.length, targetItems);
    if (first <= 0) break;

    const { json, list } = await readPage(first, after);
    if (json.errors?.length) {
      throw new Error(
        hasForbiddenError(json.errors) ? errors.private : errors.notFound,
      );
    }
    if (!list) throw new Error(errors.notFound);
    if (list.visibility?.id === "PRIVATE") throw new Error(errors.private);

    const search = list.titleListItemSearch;
    targetItems = Math.min(search?.total ?? maxItems, maxItems);
    const pageInfo = search?.pageInfo;
    const pageCapacity = Math.max(targetItems - edges.length, 0);
    edges.push(...(search?.edges ?? []).slice(0, pageCapacity));

    if (edges.length >= targetItems) {
      if (
        (search?.total ?? 0) > maxItems ||
        (targetItems === maxItems && pageInfo?.hasNextPage)
      ) {
        truncate();
      }
      break;
    }
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;

    if (page === maxPages - 1) truncate();
  }

  return { items: edges, complete };
}

export async function getImdbWatchlist(input: string) {
  const userId = await normalizeImdbUserId(input);
  return readListPages(
    `Watchlist for ${userId}`,
    { private: ERROR_PRIVATE, notFound: ERROR_NOT_FOUND },
    async (first, after) => {
      const json = await queryImdbGraphQL("WatchListPage", WATCHLIST_QUERY, {
        urConst: userId,
        first,
        after,
      });
      return { json, list: json.data?.predefinedList };
    },
  );
}

function processWatchlist(edges: ImdbEdge[]) {
  const items: ProcessedItem[] = [];

  for (const edge of edges) {
    const movieData = edge.listItem;

    const item: ProcessedItem = {
      id: movieData.id,
      title: movieData.titleText?.text ?? null,
      type: movieData.titleType?.text ?? null,
      year: movieData.releaseYear?.year ?? null,
      released: releaseDate(movieData.releaseDate),
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

function releaseDate(date: TitleNode["releaseDate"]) {
  if (!date?.year || !date.month || !date.day) return undefined;
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    value.getUTCFullYear() !== date.year ||
    value.getUTCMonth() !== date.month - 1 ||
    value.getUTCDate() !== date.day
  )
    return undefined;
  return value.toISOString();
}

function formatRuntime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const MOVIE_TYPES = new Set([
  "Movie",
  "TV Movie",
  "TV Special",
  "Short",
  "TV Short",
  "Video",
]);
const SERIES_TYPES = new Set(["TV Series", "TV Mini Series"]);

function convertToStremioFormat(items: ProcessedItem[]) {
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
      poster: item.image_url,
      posterShape: "poster",
      type: isMovie ? "movie" : "series",
      genres: item.genres,
      ...(item.released ? { released: item.released } : {}),
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

  return metas;
}

/** A watchlist, list or chart: its Titles and when each one was added. */
export interface ImdbListData extends CatalogData {
  /** False when the read stopped before the last page. */
  complete: boolean;
  /** IMDb ID to the date the Title was added to the list. */
  addedAt?: Map<string, string>;
}

function addedDates(edges: ImdbEdge[]) {
  const dates = new Map<string, string>();
  for (const edge of edges) {
    const date = edge.node?.createdDate;
    if (date && !dates.has(edge.listItem.id)) dates.set(edge.listItem.id, date);
  }
  return dates;
}

export function isListId(id: string) {
  return id.startsWith("ls");
}

function toMetas(edges: ImdbEdge[], read: string) {
  console.log(`Raw ${read} (${edges.length} items)`);
  const metas = convertToStremioFormat(processWatchlist(edges));
  console.log(`Converted ${metas.length} items to Stremio format`);
  return metas;
}

export async function fetchWatchlist(imdbUserId: string) {
  console.log(`Fetching IMDb watchlist for user ${imdbUserId}...`);
  const { items, complete } = await getImdbWatchlist(imdbUserId);
  const metas = toMetas(
    items,
    `watchlist data received from IMDb for user ${imdbUserId}`,
  );
  return { metas, complete, addedAt: addedDates(items) };
}

async function getChartEdges(entry: ChartEntry) {
  switch (entry.query.kind) {
    case "chartTitles": {
      const query = buildChartTitlesQuery(entry.query.chartType);
      const edges: ImdbEdge[] = [];
      let after: string | null = null;

      for (let page = 0; page < entry.maxPages; page++) {
        const json: GraphQLResponse = await queryImdbGraphQL(
          "ChartTitles",
          query,
          { first: entry.first, after },
        );

        if (json.errors?.length) {
          throw new Error(ERROR_NOT_FOUND);
        }

        const chart = json.data?.chartTitles;
        if (!chart) {
          throw new Error(ERROR_NOT_FOUND);
        }

        for (const edge of chart.edges ?? []) {
          edges.push({ listItem: edge.node });
        }

        const pageInfo = chart.pageInfo;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
          break;
        }
        after = pageInfo.endCursor;
      }

      return edges;
    }

    case "boxOffice": {
      const json = await queryImdbGraphQL("BoxOffice", BOX_OFFICE_QUERY, {});

      if (json.errors?.length) {
        throw new Error(ERROR_NOT_FOUND);
      }

      const releases = json.data?.topGrossingReleases;
      if (!releases) {
        throw new Error(ERROR_NOT_FOUND);
      }

      const edges: ImdbEdge[] = [];
      for (const edge of releases.edges ?? []) {
        const title = edge.node.release?.titles?.[0];
        if (!title) {
          continue;
        }
        edges.push({ listItem: title });
      }

      return edges;
    }

    case "comingSoon": {
      const date = new Date().toISOString().slice(0, 10);
      const query = buildComingSoonQuery(entry.query.comingSoonType, date);
      const json = await queryImdbGraphQL("ComingSoon", query, {
        first: entry.first,
      });

      if (json.errors?.length) {
        throw new Error(ERROR_NOT_FOUND);
      }

      const comingSoon = json.data?.comingSoon;
      if (!comingSoon) {
        throw new Error(ERROR_NOT_FOUND);
      }

      return (comingSoon.edges ?? []).map((edge) => ({ listItem: edge.node }));
    }
  }
}

export async function fetchChart(sourceId: string) {
  const entry = CHART_BY_ID.get(sourceId);
  if (!entry) {
    throw new Error(ERROR_NOT_FOUND);
  }

  console.log(`Fetching IMDb chart ${sourceId}...`);
  const edges = await getChartEdges(entry);
  const metas = toMetas(edges, `chart data received from IMDb for ${sourceId}`);
  return { metas, complete: true };
}

export async function validateImdbList(listId: string) {
  try {
    const json = await queryImdbGraphQL("ValidateList", VALIDATE_LIST_QUERY, {
      listId,
    });
    return validationResult(json, json.data?.list);
  } catch {
    return { valid: false, reason: "not_found" };
  }
}

export function getImdbList(listId: string) {
  return readListPages(
    `List ${listId}`,
    { private: ERROR_LIST_PRIVATE, notFound: ERROR_LIST_NOT_FOUND },
    async (first, after) => {
      const json = await queryImdbGraphQL("ListPage", LIST_QUERY, {
        listId,
        first,
        after,
      });
      return { json, list: json.data?.list };
    },
  );
}

export async function fetchList(listId: string) {
  console.log(`Fetching IMDb list ${listId}...`);
  const { items, complete } = await getImdbList(listId);
  const metas = toMetas(items, `list data received from IMDb for ${listId}`);
  return { metas, complete, addedAt: addedDates(items) };
}

/**
 * Whether a user's ratings are public. IMDb refuses the ratings of a missing
 * user as it refuses private ones, so the watchlist query tells them apart:
 * it answers null for a missing user.
 */
export async function validateImdbRatings(input: string) {
  let userId: string;
  try {
    userId = await normalizeImdbUserId(input);
  } catch {
    return { valid: false, reason: "not_found" };
  }

  const json = await queryImdbGraphQL(
    "ValidateRatings",
    VALIDATE_RATINGS_QUERY,
    { userId },
  );
  if (!json.errors?.length && json.data?.advancedTitleSearch) {
    return { valid: true, userId };
  }
  if (!hasForbiddenError(json.errors)) {
    throw new Error(`IMDb could not check the ratings of ${userId}`);
  }
  const owner = await queryImdbGraphQL("ValidateWatchlist", VALIDATE_QUERY, {
    urConst: userId,
  });
  const exists =
    !!owner.data?.predefinedList || hasForbiddenError(owner.errors);
  return { valid: false, reason: exists ? "private" : "not_found" };
}

/** The newest MAX_RATINGS ratings of a user, newest first. */
export async function getImdbRatings(input: string) {
  const userId = await normalizeImdbUserId(input);
  return readListPages(
    `Ratings of ${userId}`,
    { private: ERROR_RATINGS_PRIVATE, notFound: ERROR_RATINGS_NOT_FOUND },
    async (first, after) => {
      const json = await queryImdbGraphQL("UserRatings", RATINGS_QUERY, {
        userId,
        first,
        after,
      });
      if (json.errors?.length && !hasForbiddenError(json.errors)) {
        throw new Error(`IMDb could not read the ratings of ${userId}`);
      }
      const search = json.data?.advancedTitleSearch;
      return {
        json,
        list: search && {
          titleListItemSearch: {
            total: search.total,
            pageInfo: search.pageInfo,
            edges: (search.edges ?? []).flatMap((edge) => {
              const title = edge.node?.title;
              return title
                ? [
                    {
                      node: { createdDate: title.userRating?.date },
                      listItem: title,
                    },
                  ]
                : [];
            }),
          },
        },
      };
    },
    MAX_RATINGS,
  );
}

/** A user's ratings, oldest first, each dated by its rating. */
export async function fetchRatings(userId: string) {
  console.log(`Fetching IMDb ratings of ${userId}...`);
  const { items, complete } = await getImdbRatings(userId);
  const oldestFirst = [...items].reverse();
  const metas = toMetas(
    oldestFirst,
    `ratings received from IMDb for ${userId}`,
  );
  return { metas, complete, addedAt: addedDates(oldestFirst) };
}

const TITLES_BY_ID_QUERY = `
  query TitlesById($ids: [ID!]!) {
    titles(ids: $ids) { ${TITLE_FRAGMENT} }
  }
`;

const TITLES_BATCH_SIZE = 250;

/**
 * Full Stremio metadata for IMDb IDs, in batches. Used by the shared
 * enrichment step for Providers that only give IMDb IDs. Unknown IDs and
 * non-video titles (episodes, games…) are left out of the result.
 */
export async function fetchTitlesByIds(imdbIds: string[]) {
  const result = new Map<string, StremioMeta>();
  for (let start = 0; start < imdbIds.length; start += TITLES_BATCH_SIZE) {
    const ids = imdbIds.slice(start, start + TITLES_BATCH_SIZE);
    const json = await queryImdbGraphQL("TitlesById", TITLES_BY_ID_QUERY, {
      ids,
    });
    const nodes = (json.data?.titles ?? []).filter(
      (node): node is TitleNode => !!node?.id && !!node.titleText,
    );
    const metas = convertToStremioFormat(
      processWatchlist(nodes.map((listItem) => ({ listItem }))),
    );
    for (const meta of metas) result.set(meta.id, meta);
  }
  return result;
}
