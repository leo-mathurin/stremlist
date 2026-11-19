import { http, HttpResponse } from "msw";
import { z } from "zod";

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

/** One SPARQL lookup that the fake Wikidata received. */
export interface WikidataQuery {
  property: string;
  values: string[];
}

const valuesSchema = z.array(z.string());

function parseQuery(query: string) {
  const property = /wdt:(P\d+) \?external/.exec(query)?.[1] ?? "";
  const values = /VALUES \?external \{([^}]*)\}/.exec(query)?.[1] ?? "";
  const quoted = values.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  return {
    property,
    values: valuesSchema.parse(JSON.parse(`[${quoted.join(",")}]`)),
  };
}

/**
 * The Wikidata SPARQL endpoint in memory. It answers the external ID to IMDb
 * ID lookups of `titles/wikidata` with the links that a test stores, and
 * keeps every lookup it receives.
 */
export class FakeWikidata {
  /** IMDb IDs by `${property}:${externalId}`. */
  readonly links = new Map<string, string[]>();
  readonly queries: WikidataQuery[] = [];
  /** When set, every lookup fails with this HTTP status. */
  failStatus: number | null = null;

  /** The MSW handler of the SPARQL endpoint. */
  readonly handler = http.post(WIKIDATA_SPARQL, ({ request }) =>
    this.answer(request),
  );

  reset() {
    this.links.clear();
    this.queries.length = 0;
    this.failStatus = null;
  }

  /** Links the external ID of `property` to these IMDb IDs. */
  link(property: string, externalId: string, ...imdbIds: string[]) {
    this.links.set(`${property}:${externalId}`, imdbIds);
  }

  async answer(request: Request) {
    const form = new URLSearchParams(await request.text());
    const query = parseQuery(form.get("query") ?? "");
    this.queries.push(query);
    if (this.failStatus !== null) {
      return new HttpResponse("Unavailable", { status: this.failStatus });
    }
    const bindings = query.values.flatMap((external) =>
      (this.links.get(`${query.property}:${external}`) ?? []).map((imdb) => ({
        external: { value: external },
        imdb: { value: imdb },
      })),
    );
    return HttpResponse.json({ results: { bindings } });
  }
}
