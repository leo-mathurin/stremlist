import { providerFetch, RateLimiter } from "../providers/http";
import type { ResolverStrategy, SourceEntry } from "../providers/types";

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
/** Wikidata property "IMDb ID". */
const IMDB_PROPERTY = "P345";
/** IDs per SPARQL query: one request covers a full resolver batch. */
const BATCH_SIZE = 200;
// The query service allows 5 parallel queries per client; stay well below.
const wikidataLimiter = new RateLimiter(2, 1000);

const PROPERTY_PATTERN = /^P\d+$/;
const IMDB_ID = /^tt\d+$/;

interface SparqlResponse {
  results?: {
    bindings?: Record<string, { value?: string } | undefined>[];
  };
}

/** Quote a value as a SPARQL string literal. */
function sparqlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Map external IDs of one Wikidata property (for example P10100, SensCritique
 * work ID) to IMDb IDs, with one SPARQL query per batch. An external ID that
 * Wikidata links to several different Titles is left out: it is ambiguous.
 */
export async function wikidataImdbIds(
  property: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (!PROPERTY_PATTERN.test(property)) {
    throw new Error(`Invalid Wikidata property: ${property}`);
  }
  const found = new Map<string, string>();
  const ambiguous = new Set<string>();
  const unique = [...new Set(ids)];

  for (let start = 0; start < unique.length; start += BATCH_SIZE) {
    const batch = unique.slice(start, start + BATCH_SIZE);
    // wdt: reads only best-rank statements, so deprecated IMDb IDs are skipped.
    const query = `SELECT ?external ?imdb WHERE {
  VALUES ?external { ${batch.map(sparqlString).join(" ")} }
  ?item wdt:${property} ?external ;
        wdt:${IMDB_PROPERTY} ?imdb .
}`;
    const response = await providerFetch(WIKIDATA_SPARQL, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query }).toString(),
      limiter: wikidataLimiter,
      timeoutMs: 30_000,
    });
    if (!response.ok) {
      throw new Error(`Wikidata SPARQL returned ${response.status}`);
    }
    const json = (await response.json()) as SparqlResponse;
    for (const binding of json.results?.bindings ?? []) {
      const external = binding.external?.value;
      const imdbId = binding.imdb?.value;
      if (!external || !imdbId || !IMDB_ID.test(imdbId)) continue;
      const previous = found.get(external);
      if (previous && previous !== imdbId) ambiguous.add(external);
      found.set(external, imdbId);
    }
  }

  for (const external of ambiguous) found.delete(external);
  return found;
}

/**
 * Resolver strategy that looks up the entries' external IDs on Wikidata.
 * Exact: it only follows links that Wikidata editors made.
 */
export function wikidataStrategy(
  name: string,
  property: string,
  externalId: (entry: SourceEntry) => string | undefined,
): ResolverStrategy {
  return {
    name,
    async resolve(entries) {
      const ids = entries.map(externalId);
      const imdbIds = await wikidataImdbIds(
        property,
        ids.filter((id): id is string => !!id),
      );
      const found = new Map<number, string>();
      ids.forEach((id, index) => {
        const imdbId = id ? imdbIds.get(id) : undefined;
        if (imdbId) found.set(index, imdbId);
      });
      return found;
    },
  };
}
