// Loaded only by the isolated backend of `new-titles.spec.ts`. The real
// adapters, ID resolver, enrichment, database and R2 code run; only the
// Provider transport is replaced by Source lists that the test controls
// through a JSON file. Loopback requests (Supabase) use the real fetch. Every
// other destination is refused, so no real Provider is ever called.
import { readFileSync } from "node:fs";

/** The Source lists that the test writes to E2E_SOURCE_FIXTURE_FILE. */
export interface SourceFixture {
  /** IMDb watchlists by `ur…` ID: the IMDb IDs, oldest added first. */
  imdb: Record<string, { ids: string[]; fail?: boolean }>;
  /** Public Trakt watchlists by user. An item without `imdb` stays unresolved. */
  trakt: Record<
    string,
    {
      items: { trakt: number; imdb?: string; name: string; year: number }[];
      fail?: boolean;
    }
  >;
  /** IMDb metadata of every Title the fixture uses. */
  titles: Record<
    string,
    { name: string; year: number; type: "movie" | "series" }
  >;
}

const realFetch = globalThis.fetch;
const fixtureFile = process.env.E2E_SOURCE_FIXTURE_FILE;
if (!fixtureFile) throw new Error("E2E_SOURCE_FIXTURE_FILE is not set");

function fixture(): SourceFixture {
  return JSON.parse(readFileSync(fixtureFile!, "utf8")) as SourceFixture;
}

function titleNode(id: string, state: SourceFixture) {
  const title = state.titles[id];
  if (!title) throw new Error(`The fixture has no metadata for ${id}`);
  return {
    id,
    titleText: { text: title.name },
    titleType: { text: title.type === "series" ? "TV Series" : "Movie" },
    releaseYear: { year: title.year },
    ratingsSummary: { aggregateRating: 7 },
    titleGenres: { genres: [{ genre: { text: "Drama" } }] },
    plot: { plotText: { plainText: `${title.name} fixture plot.` } },
    primaryImage: { url: "https://stremlist.com/icon.png" },
    runtime: { seconds: 5400 },
    principalCredits: [],
  };
}

async function imdb(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    operationName: string;
    variables: Record<string, unknown>;
  };
  const state = fixture();
  if (body.operationName === "WatchListPage") {
    const list = state.imdb[String(body.variables.urConst)];
    if (!list) return Response.json({ data: { predefinedList: null } });
    if (list.fail) return new Response("Fixture outage", { status: 503 });
    return Response.json({
      data: {
        predefinedList: {
          id: body.variables.urConst,
          visibility: { id: "PUBLIC" },
          titleListItemSearch: {
            total: list.ids.length,
            edges: list.ids.map((id) => ({ listItem: titleNode(id, state) })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  }
  if (body.operationName === "TitlesById") {
    const ids = body.variables.ids as string[];
    return Response.json({
      data: {
        titles: ids
          .filter((id) => state.titles[id])
          .map((id) => titleNode(id, state)),
      },
    });
  }
  throw new Error(`Unexpected IMDb operation ${body.operationName}`);
}

function trakt(url: URL): Response {
  const user = /^\/users\/([^/]+)\/watchlist$/.exec(url.pathname)?.[1];
  const list = user ? fixture().trakt[user] : undefined;
  if (!list) return Response.json({ error: "not found" }, { status: 404 });
  if (list.fail) return new Response("Fixture outage", { status: 503 });
  return Response.json(
    list.items.map((item, index) => ({
      type: "movie",
      listed_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      movie: {
        title: item.name,
        year: item.year,
        ids: { trakt: item.trakt, ...(item.imdb ? { imdb: item.imdb } : {}) },
      },
    })),
  );
}

Object.defineProperty(globalThis, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return realFetch(request);
    }
    if (url.origin === "https://api.graphql.imdb.com") return imdb(request);
    if (url.origin === "https://api.trakt.tv") return trakt(url);
    // Enrichment falls back to Cinemeta for Titles IMDb did not answer.
    if (url.origin === "https://v3-cinemeta.strem.io") {
      return new Response("Not found", { status: 404 });
    }
    throw new Error(`Source fixture refuses outbound request to ${url.origin}`);
  },
});
