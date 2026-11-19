import {
  SIMKL_ADULT_GENRES,
  SIMKL_CHART_PERIODS,
  SIMKL_CHART_TYPES,
  simklGenreChartOf,
  simklTrendingRef,
} from "@stremlist/shared/simkl-charts";
import type { SimklChartType } from "@stremlist/shared/simkl-charts";
import { z } from "zod";
import { providerFetchJson, RateLimiter, sourceErrorFromHttp } from "../http";
import type { SourceEntry } from "../types";
import { SourceUnavailableError } from "../types";
import { simklAppQuery } from "./api";
import { toEntry } from "./entries";
import type { SimklKind } from "./library";
import { parseIds, rawIdsSchema, toInt } from "./library";

export const CDN_URL = "https://data.simkl.in";
const DISCOVER_URL = `${CDN_URL}/discover`;

const KIND_OF_TYPE: Record<SimklChartType, SimklKind> = {
  movies: "movies",
  tv: "shows",
  anime: "anime",
};

const HOURLY_FRESHNESS_MS = 60 * 60_000;
const DAILY_FRESHNESS_MS = 6 * 60 * 60_000;
const CDN_MAX_AGE_MS = 60 * 60_000;

interface ChartFile {
  path: string;
  kind: SimklKind;
  freshnessMs: number;
}

const CHART_FILES = new Map<string, ChartFile>([
  ...SIMKL_CHART_TYPES.flatMap((type) =>
    SIMKL_CHART_PERIODS.map(
      (period) =>
        [
          simklTrendingRef(type, period),
          {
            path: `trending/${type}/${period}_100.json`,
            kind: KIND_OF_TYPE[type],
            freshnessMs:
              period === "today" ? HOURLY_FRESHNESS_MS : DAILY_FRESHNESS_MS,
          },
        ] satisfies [string, ChartFile],
    ),
  ),
  [
    "dvd/releases",
    {
      path: "dvd/releases_100.json",
      kind: "movies",
      freshnessMs: DAILY_FRESHNESS_MS,
    },
  ],
]);

function chartFile(ref: string) {
  const fixed = CHART_FILES.get(ref);
  if (fixed) return fixed;
  const genre = simklGenreChartOf(ref);
  if (!genre || SIMKL_ADULT_GENRES.has(genre.slug)) return null;
  const file: ChartFile = {
    path: `trending/${genre.type}/genre/${genre.slug}_month_500.json`,
    kind: KIND_OF_TYPE[genre.type],
    freshnessMs: DAILY_FRESHNESS_MS,
  };
  return file;
}

/** Whether a reference is one of Simkl's CDN charts. */
export function isChartRef(ref: string) {
  return chartFile(ref) !== null;
}

/** How long a Catalog of the chart stays fresh. */
export function chartFreshness(ref: string) {
  return chartFile(ref)?.freshnessMs;
}

const cdnLimiter = new RateLimiter(4, 1000);

const trendingItemSchema = z.object({
  title: z.string().nullish(),
  release_date: z.string().nullish(),
  anime_type: z.string().nullish(),
  ids: rawIdsSchema.nullish(),
});

function toTrendingEntry(
  item: z.infer<typeof trendingItemSchema>,
  kind: SimklKind,
) {
  const { simkl, ...ids } = parseIds(item.ids ?? {});
  if (!simkl) return null;
  return toEntry({
    simkl,
    kind,
    ...ids,
    title: item.title ?? undefined,
    year: toInt(/(\d{4})$/.exec(item.release_date ?? "")?.[1]),
    animeType: item.anime_type ?? undefined,
  });
}

/** A file of Simkl's CDN, with the parameters that Simkl wants on each call. */
export async function readCdnFile(url: string) {
  const { data } = await providerFetchJson(url, {
    query: simklAppQuery(),
    headers: { Accept: "application/json" },
    limiter: cdnLimiter,
  });
  return data;
}

async function readFile(file: ChartFile) {
  let data: unknown;
  try {
    data = await readCdnFile(`${DISCOVER_URL}/${file.path}`);
  } catch (error) {
    throw sourceErrorFromHttp(
      error,
      { 404: "not_found" },
      () => `Simkl has no chart file ${file.path}`,
    );
  }
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  for (const item of z.array(trendingItemSchema).parse(data)) {
    const entry = toTrendingEntry(item, file.kind);
    if (!entry) continue;
    if (entry.imdbId) {
      if (seen.has(entry.imdbId)) continue;
      seen.add(entry.imdbId);
    }
    entries.push(entry);
  }
  return entries;
}

/** A read in this instance, shared while the CDN keeps the file. */
export interface SharedRead<T> {
  at: number;
  value: Promise<T>;
}

/**
 * The value of `key`, read again when the CDN's copy is older than its
 * cache time or `forceRefresh` asks for it. A failed read is forgotten.
 */
export function sharedRead<T>(
  reads: Map<string, SharedRead<T>>,
  key: string,
  read: () => Promise<T>,
  { forceRefresh = false, maxAgeMs = CDN_MAX_AGE_MS } = {},
) {
  const previous = reads.get(key);
  if (previous && !forceRefresh && Date.now() - previous.at < maxAgeMs) {
    return previous.value;
  }
  const current = { at: Date.now(), value: read() };
  reads.set(key, current);
  current.value.catch(() => {
    if (reads.get(key) === current) reads.delete(key);
  });
  return current.value;
}

const reads = new Map<string, SharedRead<SourceEntry[]>>();

const genreIndexes = new Map<string, SharedRead<Set<string>>>();

/** Test hook: forget the shared reads. */
export function clearTrendingReads() {
  reads.clear();
  genreIndexes.clear();
}

const genreIndexSchema = z.array(z.object({ slug: z.string() }));

/** Whether Simkl has a trending file for this genre now. */
export async function genreExists(ref: string) {
  const genre = simklGenreChartOf(ref);
  if (!genre || SIMKL_ADULT_GENRES.has(genre.slug)) return false;
  const slugs = await sharedRead(genreIndexes, genre.type, async () => {
    const data = await readCdnFile(
      `${DISCOVER_URL}/trending/${genre.type}/genre/index.json`,
    );
    return new Set(genreIndexSchema.parse(data).map((item) => item.slug));
  });
  return slugs.has(genre.slug);
}

/** A chart in Simkl's rank order, from Simkl's CDN, with no token. */
export async function readTrending(ref: string, forceRefresh = false) {
  const file = chartFile(ref);
  if (!file) {
    throw new SourceUnavailableError("not_found", `Unknown Simkl chart ${ref}`);
  }
  const entries = await sharedRead(reads, file.path, () => readFile(file), {
    forceRefresh,
  });
  return { entries: structuredClone(entries), complete: true };
}
