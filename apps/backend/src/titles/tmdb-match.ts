import type { ResolverStrategy, SourceEntry } from "../providers/types";
import { isTmdbConfigured, mapWithConcurrency, tmdbGet } from "./tmdb";

const CONCURRENCY = 6;
/** Search results checked per query, in TMDB relevance order. */
const CANDIDATES_PER_QUERY = 2;
const YEAR_TOLERANCE = 1;
const SERIES_EARLIER_YEARS = 10;
const RUNTIME_TOLERANCE_MINUTES = 10;
const IMDB_ID = /^tt\d+$/;

interface TmdbSearchResult {
  id: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
}

interface TmdbPerson {
  name: string;
  original_name?: string;
  job?: string;
}

interface TmdbMovieDetails {
  imdb_id?: string | null;
  runtime?: number | null;
  credits?: { crew?: TmdbPerson[] };
}

interface TmdbTvDetails {
  episode_run_time?: number[];
  last_episode_to_air?: { runtime?: number | null } | null;
  created_by?: TmdbPerson[];
  external_ids?: { imdb_id?: string | null };
}

/** What TMDB knows about a candidate, reduced to what the match checks. */
interface Candidate {
  imdbId: string | null;
  people: string[];
  runtimes: number[];
}

/** Lowercase, without accents, spaces or punctuation. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Spellings of one person name to compare: the name itself, without an alias
 * in parentheses ("Pernilla August (Pernilla Östergren)"), the alias alone,
 * and each of them with its words sorted ("Lee Sang-il", "Sang-il Lee").
 */
function nameKeys(name: string): string[] {
  const alias = /\(([^)]*)\)/.exec(name)?.[1];
  const forms = [name, name.replace(/\([^)]*\)/g, " "), alias ?? ""];
  const keys = new Set<string>();
  for (const form of forms) {
    const words = form
      .split(/[\s-]+/)
      .map(normalizeText)
      .filter(Boolean);
    if (words.length === 0) continue;
    keys.add(words.join(""));
    keys.add([...words].sort().join(""));
  }
  return [...keys];
}

/**
 * Whether two person names are the same person. Small spelling differences
 * are allowed for long names, because transliterations differ between
 * services ("Andreï Tarkovski" on SensCritique, "Andrei Tarkovsky" on TMDB).
 */
export function samePerson(a: string, b: string): boolean {
  const left = nameKeys(a);
  const right = nameKeys(b);
  return left.some((x) =>
    right.some(
      (y) =>
        x === y ||
        (Math.min(x.length, y.length) >= 8 && editDistance(x, y) <= 2),
    ),
  );
}

function yearOf(date: string | undefined): number | undefined {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

/**
 * Candidate year minus entry year, 0 when the entry has no year (the other
 * checks then decide alone), null when only the candidate has none.
 */
function yearGap(
  entryYear: number | undefined,
  candidateYear: number | undefined,
): number | null {
  if (entryYear === undefined) return 0;
  if (candidateYear === undefined) return null;
  return candidateYear - entryYear;
}

function yearAllowed(type: "movie" | "series", gap: number | null): boolean {
  if (gap === null) return false;
  // Series dates on SensCritique are often the French broadcast, years after
  // the original run (Parks and Recreation: 2015 for 2009).
  const earliest = type === "series" ? -SERIES_EARLIER_YEARS : -YEAR_TOLERANCE;
  return gap >= earliest && gap <= YEAR_TOLERANCE;
}

async function loadCandidate(
  id: number,
  type: "movie" | "series",
): Promise<Candidate | null> {
  if (type === "movie") {
    const movie = await tmdbGet<TmdbMovieDetails>(`/movie/${id}`, {
      append_to_response: "credits",
    });
    if (!movie) return null;
    return {
      imdbId: movie.imdb_id ?? null,
      people: (movie.credits?.crew ?? [])
        .filter((person) => person.job === "Director")
        .flatMap((person) => [person.name, person.original_name ?? ""]),
      runtimes: movie.runtime ? [movie.runtime] : [],
    };
  }
  const show = await tmdbGet<TmdbTvDetails>(`/tv/${id}`, {
    append_to_response: "external_ids",
  });
  if (!show) return null;
  const runtimes = [...(show.episode_run_time ?? [])];
  if (show.last_episode_to_air?.runtime) {
    runtimes.push(show.last_episode_to_air.runtime);
  }
  return {
    imdbId: show.external_ids?.imdb_id ?? null,
    people: (show.created_by ?? []).flatMap((person) => [
      person.name,
      person.original_name ?? "",
    ]),
    runtimes,
  };
}

/**
 * Decide whether a TMDB candidate is the entry's Title. The search already
 * agrees on the title and roughly on the year, so this asks for one more
 * independent fact. A known director (or series creator) that disagrees
 * rejects the candidate even when the runtime agrees: a wrong Title is worse
 * than an Unresolved entry, which the resolver retries later.
 */
export function candidateMatches(
  entry: SourceEntry,
  candidate: Pick<Candidate, "people" | "runtimes"> & {
    titles: string[];
    /** Candidate year minus entry year. */
    yearGap: number;
  },
): boolean {
  const directors = entry.directors?.filter(Boolean) ?? [];
  const people = candidate.people.filter(Boolean);
  if (directors.length > 0 && people.length > 0) {
    return directors.some((director) =>
      people.some((person) => samePerson(director, person)),
    );
  }
  // Without people to compare, the runtime must agree, the title must be the
  // same (not only similar enough for TMDB's search) and the year close.
  const runtime = entry.runtimeMinutes;
  const runtimeAgrees =
    !!runtime &&
    candidate.runtimes.some(
      (value) => Math.abs(value - runtime) <= RUNTIME_TOLERANCE_MINUTES,
    );
  const titles = new Set(
    [entry.title, entry.originalTitle]
      .filter((value): value is string => !!value)
      .map(normalizeText),
  );
  const titleAgrees = candidate.titles.some((title) =>
    titles.has(normalizeText(title)),
  );
  return (
    runtimeAgrees &&
    titleAgrees &&
    entry.year !== undefined &&
    Math.abs(candidate.yearGap) <= YEAR_TOLERANCE
  );
}

function gapOf(entry: SourceEntry, result: TmdbSearchResult): number | null {
  return yearGap(
    entry.year,
    yearOf(result.release_date ?? result.first_air_date),
  );
}

async function searchTmdb(
  type: "movie" | "series",
  query: string,
  year?: number,
): Promise<TmdbSearchResult[]> {
  const params: Record<string, string> = {
    query,
    language: "fr-FR",
    include_adult: "false",
  };
  if (year !== undefined) params.year = String(year);
  const search = await tmdbGet<{ results?: TmdbSearchResult[] }>(
    type === "movie" ? "/search/movie" : "/search/tv",
    params,
  );
  return search?.results ?? [];
}

/**
 * Find the IMDb ID of an entry that has only a title, a year and a few facts
 * (SensCritique products have no external ID). Returns null when no
 * candidate passes candidateMatches().
 */
export async function matchOnTmdb(entry: SourceEntry): Promise<string | null> {
  const type = entry.type;
  if (!type) return null;
  const queries = [
    ...new Set(
      [entry.originalTitle, entry.title].filter(
        (value): value is string => !!value?.trim(),
      ),
    ),
  ];
  const checked = new Set<number>();

  for (const query of queries) {
    let results = await searchTmdb(type, query);
    // A common title ("Escape", 1948) can push the Title off the first page:
    // search again within its year. Series years are too loose for that.
    if (
      type === "movie" &&
      entry.year !== undefined &&
      !results.some((result) => yearAllowed(type, gapOf(entry, result)))
    ) {
      results = await searchTmdb(type, query, entry.year);
    }

    // The closest year first: a sequel or a remake by the same director a
    // few years later must not win over the Title itself (Police Story,
    // 1985, and Police Story 2, 1988).
    const candidates = results
      .map((result, rank) => ({ result, rank, gap: gapOf(entry, result) }))
      .filter(
        (item): item is typeof item & { gap: number } =>
          !checked.has(item.result.id) && yearAllowed(type, item.gap),
      )
      .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || a.rank - b.rank)
      .slice(0, CANDIDATES_PER_QUERY);

    for (const { result, gap } of candidates) {
      checked.add(result.id);
      const candidate = await loadCandidate(result.id, type);
      if (!candidate?.imdbId || !IMDB_ID.test(candidate.imdbId)) continue;
      const titles = [
        result.title,
        result.original_title,
        result.name,
        result.original_name,
      ].filter((value): value is string => !!value);
      if (candidateMatches(entry, { ...candidate, titles, yearGap: gap })) {
        return candidate.imdbId;
      }
    }
  }
  return null;
}

/**
 * Resolver strategy for entries without any external ID: a TMDB title search
 * checked against the director or the runtime. Use it last, after the exact
 * strategies.
 */
export const tmdbSearchMatchStrategy: ResolverStrategy = {
  name: "tmdb-search-match",
  async resolve(entries) {
    const found = new Map<number, string>();
    if (!isTmdbConfigured()) return found;
    let failures = 0;
    let lastError: unknown;
    await mapWithConcurrency(entries, CONCURRENCY, async (entry, index) => {
      try {
        const imdbId = await matchOnTmdb(entry);
        if (imdbId) found.set(index, imdbId);
      } catch (error) {
        failures++;
        lastError = error;
      }
    });
    // One failed entry must not discard the others' results; a full outage
    // still surfaces as a strategy failure.
    if (failures > 0 && found.size === 0 && failures === entries.length) {
      throw lastError;
    }
    if (failures > 0) {
      console.warn(
        `TMDB search match failed for ${failures} entries:`,
        lastError instanceof Error ? lastError.message : lastError,
      );
    }
    return found;
  },
};
