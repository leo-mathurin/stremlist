import { IMDB_USER_AGENT, DEFAULT_SORT_OPTIONS } from "@stremlist/shared";
import type {
  SortOptions,
  StremioMeta,
  WatchlistData,
} from "@stremlist/shared";
import { parseHTML } from "linkedom";

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

interface ImdbNextData {
  props?: {
    pageProps?: {
      mainColumnData?: {
        predefinedList?: {
          titleListItemSearch?: {
            edges?: ImdbEdge[];
          };
        };
      };
    };
  };
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

export async function getImdbWatchlist(userId: string): Promise<ImdbEdge[] | null> {
  const url = `https://www.imdb.com/user/${userId}/watchlist/`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": IMDB_USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });

  if (!response.ok) {
    throw new Error(
      "Could not find an IMDb watchlist for this ID. Please check and try again.",
    );
  }

  const html = await response.text();
  const { document } = parseHTML(html);

  const pageTitle = document.title;
  if (pageTitle.toLowerCase().includes("private list")) {
    throw new Error(
      "This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.",
    );
  }

  const nextDataScript = document.querySelector('script[id="__NEXT_DATA__"]');
  if (!nextDataScript) {
    throw new Error(
      "Could not find an IMDb watchlist for this ID. Please check and try again.",
    );
  }

  const nextData = JSON.parse(nextDataScript.textContent) as ImdbNextData;

  const pageProps = nextData.props?.pageProps;
  if (!pageProps) {
    throw new Error(
      "Could not find an IMDb watchlist for this ID. Please check and try again.",
    );
  }

  if (!pageProps.mainColumnData?.predefinedList) {
    throw new Error(
      "Could not find an IMDb watchlist for this ID. Please check and try again.",
    );
  }

  const titleListItemSearch =
    pageProps.mainColumnData.predefinedList.titleListItemSearch;
  if (!titleListItemSearch) {
    throw new Error(
      "This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.",
    );
  }

  const edges = titleListItemSearch.edges ?? [];
  if (edges.length === 0) {
    return null;
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
      poster: item.image_url,
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
): Promise<WatchlistData> {
  console.log(`Fetching IMDb watchlist for user ${imdbUserId}...`);

  const edges = await getImdbWatchlist(imdbUserId);

  if (!edges) {
    throw new Error(
      "Could not find an IMDb watchlist for this ID. Please check and try again.",
    );
  }

  console.log(
    `Raw watchlist data received from IMDb for user ${imdbUserId} (${edges.length} items)`,
  );

  const processed = processWatchlist(edges);
  if (processed.length === 0) {
    throw new Error(
      "This watchlist appears to be empty or may not contain any compatible movies or series.",
    );
  }

  const metas = convertToStremioFormat(processed, sortOptions);
  console.log(
    `Converted ${metas.length} items to Stremio format (sorted by ${sortOptions.by}, ${sortOptions.order})`,
  );

  return { metas };
}
