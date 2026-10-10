// Loaded only by the isolated backend of `new-titles.spec.ts`. The real
// adapters, ID resolver, enrichment, database and R2 code run; only the
// Provider transport is replaced by Source lists that the test controls
// through a JSON file. Loopback requests (Supabase) use the real fetch. Every
// other destination is refused, so no real Provider is ever called.
import { readFileSync } from "node:fs";
import type { FixtureRequest } from "./fetch-fixture.js";
import { graphql, installFetchFixture } from "./fetch-fixture.js";

/** The Source lists that the test writes to E2E_SOURCE_FIXTURE_FILE. */
export interface SourceFixture {
  /**
   * IMDb watchlists by `ur…` ID: the IMDb IDs, oldest added first. `capped`
   * makes the watchlist longer than the page cap: the first page has the
   * IDs and every page says that more follow, so the read is cut short.
   */
  imdb: Record<string, { ids: string[]; fail?: boolean; capped?: boolean }>;
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

function imdb({ body }: FixtureRequest): Response {
  const { operation, variables } = graphql<{
    urConst?: string;
    after?: string | null;
    ids?: string[];
  }>(body);
  const state = fixture();
  if (operation === "WatchListPage") {
    const list = state.imdb[String(variables.urConst)];
    if (!list) return Response.json({ data: { predefinedList: null } });
    if (list.fail) return new Response("Fixture outage", { status: 503 });
    const firstPage = variables.after == null;
    return Response.json({
      data: {
        predefinedList: {
          id: variables.urConst,
          visibility: { id: "PUBLIC" },
          titleListItemSearch: {
            total: list.capped ? 20_000 : list.ids.length,
            edges: firstPage
              ? list.ids.map((id) => ({ listItem: titleNode(id, state) }))
              : [],
            pageInfo: list.capped
              ? { hasNextPage: true, endCursor: "fixture-next-page" }
              : { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  }
  if (operation === "TitlesById") {
    const ids = variables.ids ?? [];
    return Response.json({
      data: {
        titles: ids
          .filter((id) => state.titles[id])
          .map((id) => titleNode(id, state)),
      },
    });
  }
  throw new Error(`Unexpected IMDb operation ${operation}`);
}

function trakt({ url }: FixtureRequest): Response {
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

installFetchFixture({
  log: process.env.E2E_PROVIDER_LOG,
  hosts: {
    "api.graphql.imdb.com": imdb,
    "api.trakt.tv": trakt,
    // Enrichment falls back to Cinemeta for Titles IMDb did not answer.
    "v3-cinemeta.strem.io": () => new Response("Not found", { status: 404 }),
  },
});
