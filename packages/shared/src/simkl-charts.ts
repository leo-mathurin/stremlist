import type { DisplayMode, TitleType } from "./constants";

/**
 * Simkl's trending charts. Simkl makes them as free files on its CDN
 * (data.simkl.in): Stremlist reads them with no Connection and no user
 * quota. Simkl's API rules ask that a trending section names Simkl, so every
 * title here starts with "Simkl".
 */
export const SIMKL_CHART_TYPES = ["movies", "tv", "anime"] as const;
export type SimklChartType = (typeof SIMKL_CHART_TYPES)[number];

export const SIMKL_CHART_PERIODS = ["today", "week", "month"] as const;
export type SimklChartPeriod = (typeof SIMKL_CHART_PERIODS)[number];

interface ChartTypeInfo {
  /** The noun in a chart title, such as "Simkl Trending Movies". */
  noun: string;
  defaultDisplayMode: DisplayMode;
  /** Anime has no single Title type: anime films trend too. */
  titleType?: TitleType;
  /** Simkl's page of the type's most watched Titles. */
  url: string;
}

export const SIMKL_CHART_TYPE_INFO: Record<SimklChartType, ChartTypeInfo> = {
  movies: {
    noun: "Movies",
    defaultDisplayMode: "movie",
    titleType: "movie",
    url: "https://simkl.com/movies/best-movies/most-watched/",
  },
  tv: {
    noun: "TV",
    defaultDisplayMode: "series",
    titleType: "series",
    url: "https://simkl.com/tv/best-shows/most-watched/",
  },
  anime: {
    noun: "Anime",
    defaultDisplayMode: "series",
    url: "https://simkl.com/anime/best-anime/most-watched/",
  },
};

/** The words after the noun in a chart title. The week has none. */
export const SIMKL_PERIOD_SUFFIX: Record<SimklChartPeriod, string> = {
  today: " Today",
  week: "",
  month: " This Month",
};

/**
 * The stored reference of a trending chart. The week keeps the reference
 * that it had before the other periods came (`trending/movies`).
 */
export function simklTrendingRef(
  type: SimklChartType,
  period: SimklChartPeriod,
) {
  return period === "week" ? `trending/${type}` : `trending/${type}/${period}`;
}

/**
 * The genres of Simkl's genre charts (the trending Titles of the month in one
 * genre), as `[slug, name]`, from Simkl's genre index files. The adult
 * genres (`erotica`, `hentai`) are not here, and the backend refuses them.
 */
export const SIMKL_GENRES: Record<
  SimklChartType,
  readonly (readonly [string, string])[]
> = {
  movies: [
    ["action", "Action"],
    ["adventure", "Adventure"],
    ["animation", "Animation"],
    ["comedy", "Comedy"],
    ["crime", "Crime"],
    ["documentary", "Documentary"],
    ["drama", "Drama"],
    ["family", "Family"],
    ["fantasy", "Fantasy"],
    ["history", "History"],
    ["horror", "Horror"],
    ["music", "Music"],
    ["mystery", "Mystery"],
    ["romance", "Romance"],
    ["science-fiction", "Science Fiction"],
    ["thriller", "Thriller"],
    ["tv-movie", "TV Movie"],
    ["war", "War"],
    ["western", "Western"],
  ],
  tv: [
    ["action", "Action"],
    ["adventure", "Adventure"],
    ["animation", "Animation"],
    ["awards-show", "Awards Show"],
    ["children", "Children"],
    ["comedy", "Comedy"],
    ["crime", "Crime"],
    ["documentary", "Documentary"],
    ["drama", "Drama"],
    ["family", "Family"],
    ["fantasy", "Fantasy"],
    ["food", "Food"],
    ["game-show", "Game Show"],
    ["history", "History"],
    ["home-and-garden", "Home and Garden"],
    ["horror", "Horror"],
    ["indie", "Indie"],
    ["korean-drama", "Korean Drama"],
    ["martial-arts", "Martial Arts"],
    ["mini-series", "Mini-Series"],
    ["musical", "Musical"],
    ["mystery", "Mystery"],
    ["news", "News"],
    ["podcast", "Podcast"],
    ["reality", "Reality"],
    ["romance", "Romance"],
    ["science-fiction", "Science-Fiction"],
    ["soap", "Soap"],
    ["sport", "Sport"],
    ["suspense", "Suspense"],
    ["talk-show", "Talk Show"],
    ["thriller", "Thriller"],
    ["travel", "Travel"],
    ["video-game-play", "Video Game Play"],
    ["war", "War"],
    ["western", "Western"],
  ],
  anime: [
    ["action", "Action"],
    ["adventure", "Adventure"],
    ["comedy", "Comedy"],
    ["drama", "Drama"],
    ["ecchi", "Ecchi"],
    ["educational", "Educational"],
    ["fantasy", "Fantasy"],
    ["gag-humor", "Gag Humor"],
    ["gore", "Gore"],
    ["harem", "Harem"],
    ["historical", "Historical"],
    ["horror", "Horror"],
    ["idol", "Idol"],
    ["isekai", "Isekai"],
    ["josei", "Josei"],
    ["kids", "Kids"],
    ["magic", "Magic"],
    ["martial-arts", "Martial Arts"],
    ["mecha", "Mecha"],
    ["military", "Military"],
    ["music", "Music"],
    ["mystery", "Mystery"],
    ["mythology", "Mythology"],
    ["parody", "Parody"],
    ["psychological", "Psychological"],
    ["racing", "Racing"],
    ["reincarnation", "Reincarnation"],
    ["romance", "Romance"],
    ["samurai", "Samurai"],
    ["school", "School"],
    ["sci-fi", "Sci-Fi"],
    ["seinen", "Seinen"],
    ["shoujo", "Shoujo"],
    ["shoujo-ai", "Shoujo Ai"],
    ["shounen", "Shounen"],
    ["shounen-ai", "Shounen Ai"],
    ["slice-of-life", "Slice Of Life"],
    ["space", "Space"],
    ["sports", "Sports"],
    ["strategy-game", "Strategy Game"],
    ["super-power", "Super Power"],
    ["supernatural", "Supernatural"],
    ["thriller", "Thriller"],
    ["vampire", "Vampire"],
    ["yaoi", "Yaoi"],
    ["yuri", "Yuri"],
  ],
};

/** Genres that Stremlist never offers or reads. */
export const SIMKL_ADULT_GENRES: ReadonlySet<string> = new Set([
  "erotica",
  "hentai",
]);

export const SIMKL_GENRE_REF_PATTERN =
  /^trending\/(movies|tv|anime)\/genre\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function simklGenreRef(type: SimklChartType, slug: string) {
  return `trending/${type}/genre/${slug}`;
}

export interface SimklGenreChart {
  type: SimklChartType;
  slug: string;
  /** Such as "Simkl Trending Horror Movies". */
  title: string;
}

export function isSimklChartType(value: string): value is SimklChartType {
  return (SIMKL_CHART_TYPES as readonly string[]).includes(value);
}

export function isSimklChartPeriod(value: string): value is SimklChartPeriod {
  return (SIMKL_CHART_PERIODS as readonly string[]).includes(value);
}

/** The genre chart behind a stored reference, or null. */
export function simklGenreChartOf(ref: string) {
  const match = SIMKL_GENRE_REF_PATTERN.exec(ref);
  const [, type, slug] = match ?? [];
  if (!type || !slug || !isSimklChartType(type)) return null;
  const name =
    SIMKL_GENRES[type].find(([known]) => known === slug)?.[1] ??
    slug
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  return {
    type,
    slug,
    title: `Simkl Trending ${name} ${SIMKL_CHART_TYPE_INFO[type].noun}`,
  } satisfies SimklGenreChart;
}
