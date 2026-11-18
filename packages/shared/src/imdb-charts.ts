import type { DisplayMode } from "./constants";
import type { SourceId } from "./providers";

/**
 * The three shapes of IMDb GraphQL chart query Stremlist knows how to fetch.
 * Each maps to a distinct edge structure normalized by the backend's
 * `getChartEdges` into the shared `ImdbEdge` form.
 */
export type ChartKind =
  | { kind: "chartTitles"; chartType: string }
  | { kind: "boxOffice" }
  | { kind: "comingSoon"; comingSoonType: "MOVIE" | "TV" };

export interface ChartEntry {
  /** Stored in `user_watchlists.imdb_user_id`, e.g. "imdb:most-popular-movies". */
  id: string;
  /** Dropdown label + default catalog title. */
  label: string;
  /** One-line summary of what the chart contains (shown in the configure UI). */
  description: string;
  /** Public IMDb page this chart is sourced from (the "view on IMDb" link). */
  url: string;
  /** movie | series | split — picked to avoid empty companion catalogs. */
  defaultDisplayMode: DisplayMode;
  /** Which GraphQL query + variables to run. */
  query: ChartKind;
  /** Page size requested from IMDb. */
  first: number;
  /** Safety stop for paginated charts (chartTitles only). */
  maxPages: number;
}

/**
 * Built-in IMDb editorial charts, exposed as opt-in catalogs. A chart is just a
 * `user_watchlists` row whose `imdb_user_id` holds the synthetic id below, so no
 * table/migration/cache/catalog-id changes are needed.
 *
 * The `imdb:` prefix (colon) guarantees no collision with `ur…`/`ls…`/`p.…`
 * source ids, and validation is exact-set membership against this registry.
 */
export const CHART_REGISTRY: readonly ChartEntry[] = [
  {
    id: "imdb:most-popular-movies",
    label: "Most Popular Movies",
    description: "The 100 movies trending on IMDb right now.",
    url: "https://www.imdb.com/chart/moviemeter/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "MOST_POPULAR_MOVIES" },
    first: 100,
    maxPages: 1,
  },
  {
    id: "imdb:most-popular-tv",
    label: "Most Popular TV Shows",
    description: "The 100 TV shows trending on IMDb right now.",
    url: "https://www.imdb.com/chart/tvmeter/",
    defaultDisplayMode: "series",
    query: { kind: "chartTitles", chartType: "MOST_POPULAR_TV_SHOWS" },
    first: 100,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-movies",
    label: "Top 250 Movies",
    description: "IMDb's highest-rated movies of all time.",
    url: "https://www.imdb.com/chart/top/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "TOP_RATED_MOVIES" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-tv",
    label: "Top 250 TV Shows",
    description: "IMDb's highest-rated TV shows of all time.",
    url: "https://www.imdb.com/chart/toptv/",
    defaultDisplayMode: "series",
    query: { kind: "chartTitles", chartType: "TOP_RATED_TV_SHOWS" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-english-movies",
    label: "Top 250 English Movies",
    description: "IMDb's highest-rated English-language movies.",
    url: "https://www.imdb.com/chart/top-english-movies/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "TOP_RATED_ENGLISH_MOVIES" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-indian-movies",
    label: "Top 250 Indian Movies",
    description: "IMDb's highest-rated Indian movies.",
    url: "https://www.imdb.com/india/top-rated-indian-movies/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "TOP_RATED_INDIAN_MOVIES" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-tamil-movies",
    label: "Top 250 Tamil Movies",
    description: "IMDb's highest-rated Tamil movies.",
    url: "https://www.imdb.com/india/top-rated-tamil-movies/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "TOP_RATED_TAMIL_MOVIES" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-telugu-movies",
    label: "Top 250 Telugu Movies",
    description: "IMDb's highest-rated Telugu movies.",
    url: "https://www.imdb.com/india/top-rated-telugu-movies/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "TOP_RATED_TELUGU_MOVIES" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:top-rated-malayalam-movies",
    label: "Top 250 Malayalam Movies",
    description: "IMDb's highest-rated Malayalam movies.",
    url: "https://www.imdb.com/india/top-rated-malayalam-movies/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "TOP_RATED_MALAYALAM_MOVIES" },
    first: 250,
    maxPages: 1,
  },
  {
    id: "imdb:lowest-rated-movies",
    label: "Bottom 100 Movies",
    description: "IMDb's lowest-rated movies of all time.",
    url: "https://www.imdb.com/chart/bottom/",
    defaultDisplayMode: "movie",
    query: { kind: "chartTitles", chartType: "LOWEST_RATED_MOVIES" },
    first: 100,
    maxPages: 1,
  },
  {
    id: "imdb:box-office",
    label: "Box Office (Weekend)",
    description: "The top-grossing movies from this past weekend.",
    url: "https://www.imdb.com/chart/boxoffice/",
    defaultDisplayMode: "movie",
    query: { kind: "boxOffice" },
    first: 10,
    maxPages: 1,
  },
  {
    id: "imdb:coming-soon-movies",
    label: "Coming Soon (Movies)",
    description: "Upcoming movie releases tracked by IMDb.",
    url: "https://www.imdb.com/calendar/?type=MOVIE",
    defaultDisplayMode: "movie",
    query: { kind: "comingSoon", comingSoonType: "MOVIE" },
    first: 100,
    maxPages: 1,
  },
  {
    id: "imdb:coming-soon-tv",
    label: "Coming Soon (TV)",
    description: "Upcoming TV releases tracked by IMDb.",
    url: "https://www.imdb.com/calendar/?type=TV",
    defaultDisplayMode: "series",
    query: { kind: "comingSoon", comingSoonType: "TV" },
    first: 100,
    maxPages: 1,
  },
] as const;

export const CHART_BY_ID: ReadonlyMap<string, ChartEntry> = new Map(
  CHART_REGISTRY.map((entry) => [entry.id, entry]),
);

/** True only for ids that have a fetcher in the registry (closed set). */
export function isChartId(id: string) {
  return CHART_BY_ID.has(id);
}

/** The IMDb chart that a Source list is, if it is one. */
export function imdbChartOf(source: SourceId) {
  return source.provider === "imdb"
    ? CHART_BY_ID.get(source.sourceRef)
    : undefined;
}
