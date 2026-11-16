import { z } from "zod";
import { providerFetchJson, RateLimiter } from "../http";
import type { SourceEntry, SourceSnapshot } from "../types";
import { SourceUnavailableError } from "../types";
import { simklAppQuery } from "./api";
import { toEntry } from "./entries";
import type { SimklKind } from "./library";
import { parseIds, rawIdsSchema, toInt } from "./library";

const TRENDING_URL = "https://data.simkl.in/discover/trending";

/** The trending files, by Source list reference: the week's top 100. */
const TRENDING_FILES = new Map<string, { path: string; kind: SimklKind }>([
  ["trending/movies", { path: "movies/week_100.json", kind: "movies" }],
  ["trending/tv", { path: "tv/week_100.json", kind: "shows" }],
  ["trending/anime", { path: "anime/week_100.json", kind: "anime" }],
]);

export function isTrendingRef(ref: string): boolean {
  return TRENDING_FILES.has(ref);
}

/**
 * Simkl makes the week's files once a day, and its CDN keeps a file for an
 * hour: a Catalog stays fresh for hours.
 */
export const TRENDING_FRESHNESS_MS = 6 * 60 * 60_000;
const CDN_MAX_AGE_MS = 60 * 60_000;

// The files are free and need no user token, so one limiter serves the app.
const cdnLimiter = new RateLimiter(4, 1000);

const trendingItemSchema = z.object({
  title: z.string().nullish(),
  /** "MM/DD/YYYY". */
  release_date: z.string().nullish(),
  anime_type: z.string().nullish(),
  ids: rawIdsSchema.nullish(),
});

function toTrendingEntry(
  item: z.infer<typeof trendingItemSchema>,
  kind: SimklKind,
): SourceEntry | null {
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

async function readFile(file: {
  path: string;
  kind: SimklKind;
}): Promise<SourceEntry[]> {
  const { data } = await providerFetchJson(`${TRENDING_URL}/${file.path}`, {
    query: simklAppQuery(),
    headers: { Accept: "application/json" },
    limiter: cdnLimiter,
  });
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  for (const item of z.array(trendingItemSchema).parse(data)) {
    const entry = toTrendingEntry(item, file.kind);
    if (!entry) continue;
    // Seasons of an anime share the series' IMDb ID: keep the best ranked.
    if (entry.imdbId) {
      if (seen.has(entry.imdbId)) continue;
      seen.add(entry.imdbId);
    }
    entries.push(entry);
  }
  return entries;
}

/** Reads of each file in this instance, shared while the CDN keeps it. */
const reads = new Map<
  string,
  { at: number; entries: Promise<SourceEntry[]> }
>();

/** Test hook: forget the shared reads. */
export function clearTrendingReads(): void {
  reads.clear();
}

/** A trending chart in Simkl's rank order, from Simkl's CDN, with no token. */
export async function readTrending(
  ref: string,
  forceRefresh = false,
): Promise<SourceSnapshot> {
  const file = TRENDING_FILES.get(ref);
  if (!file) {
    throw new SourceUnavailableError("not_found", `Unknown Simkl chart ${ref}`);
  }
  let read = reads.get(ref);
  if (!read || forceRefresh || Date.now() - read.at >= CDN_MAX_AGE_MS) {
    const current = { at: Date.now(), entries: readFile(file) };
    reads.set(ref, current);
    current.entries.catch(() => {
      if (reads.get(ref) === current) reads.delete(ref);
    });
    read = current;
  }
  // Each reader gets its own copy: the shared pipeline may change entries.
  return { entries: structuredClone(await read.entries), complete: true };
}
