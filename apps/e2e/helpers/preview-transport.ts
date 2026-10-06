// Loaded only by the isolated Catalog preview backend of
// tests/catalog-preview.spec.ts. The real SensCritique adapter, ID resolver
// (Wikidata strategy and its Supabase cache) and IMDb enrichment run; every
// outbound request is answered here. No fallback to native fetch is
// permitted, including for unexpected hosts.
import { strict as assert } from "node:assert";
import {
  PREVIEW_PRIVATE_LIST,
  PREVIEW_PRODUCTS,
  PREVIEW_PUBLIC_LIST,
} from "./preview-fixture.js";

function titleNode(imdbId: string) {
  const product = PREVIEW_PRODUCTS.find((entry) => entry.imdbId === imdbId);
  assert.ok(product, `Unexpected IMDb title ${imdbId}`);
  return {
    id: imdbId,
    titleText: { text: product.englishTitle },
    titleType: { text: "Movie" },
    releaseYear: { year: product.year },
    releaseDate: { year: product.year, month: 1, day: 1 },
    ratingsSummary: { aggregateRating: product.rating },
    titleGenres: { genres: [{ genre: { text: "Animation" } }] },
    plot: { plotText: { plainText: `${product.englishTitle} plot.` } },
    primaryImage: null,
    runtime: { seconds: 7200 },
    principalCredits: [],
  };
}

const nativeFetch = globalThis.fetch;
// The local test database is the only destination that reaches the network.
const supabaseOrigin = new URL(process.env.SUPABASE_URL ?? "").origin;
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(supabaseOrigin).hostname),
  "The preview fixture needs a loopback Supabase",
);

Object.defineProperty(globalThis, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === supabaseOrigin) return nativeFetch(request);
    assert.equal(request.method, "POST");

    if (url.origin === "https://apollo.senscritique.com") {
      const body = (await request.json()) as {
        query: string;
        variables: { id: number; offset?: number };
      };
      assert.match(body.query, /query StremlistList\(/);
      const { id, offset = 0 } = body.variables;
      if (id === PREVIEW_PRIVATE_LIST) {
        return Response.json({ data: { userList: { id, isPrivate: true } } });
      }
      // Every other ID of the fixture range is the same public list, so a
      // test can ask for a list that this backend did not read yet.
      assert.ok(
        id >= PREVIEW_PUBLIC_LIST && id < PREVIEW_PUBLIC_LIST + 1000,
        `Unexpected SensCritique list ${id}`,
      );
      const items =
        offset === 0
          ? PREVIEW_PRODUCTS.map((product) => ({
              product: {
                id: product.id,
                title: product.title,
                originalTitle: null,
                yearOfProduction: product.year,
                dateReleaseOriginal: `${product.year}-01-01`,
                dateRelease: null,
                duration: 7200,
                universe: product.type === "movie" ? 1 : 4,
                directors: [],
                creators: [],
                // No JustWatch link: the JustWatch strategy has nothing to do.
                providers: [],
              },
            }))
          : [];
      return Response.json({
        data: {
          userList: {
            id,
            isPrivate: false,
            productsList: { total: PREVIEW_PRODUCTS.length, items },
          },
        },
      });
    }

    if (url.origin === "https://query.wikidata.org") {
      const query =
        new URLSearchParams(await request.text()).get("query") ?? "";
      assert.ok(query.includes("wdt:P10100"), "Unexpected SPARQL query");
      const bindings = PREVIEW_PRODUCTS.filter(
        (product) =>
          product.imdbId && query.includes(JSON.stringify(String(product.id))),
      ).map((product) => ({
        external: { value: String(product.id) },
        imdb: { value: product.imdbId },
      }));
      return Response.json({ results: { bindings } });
    }

    if (url.origin === "https://api.graphql.imdb.com") {
      const body = (await request.json()) as {
        operationName: string;
        variables: { ids: string[] };
      };
      assert.equal(body.operationName, "TitlesById");
      return Response.json({
        data: { titles: body.variables.ids.map(titleNode) },
      });
    }

    throw new Error(
      `Preview fixture refuses outbound request to ${url.origin}`,
    );
  },
});
