import { readFileSync } from "node:fs";
import type { FixtureRequest } from "./fetch.fixture.js";
import { graphql, installFetchFixture, unsupported } from "./fetch.fixture.js";
import { isRecord, isString, optional, parseJson } from "./json.js";

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

function fixturePath() {
  const file = process.env.E2E_SOURCE_FIXTURE_FILE;
  if (!file) throw new Error("E2E_SOURCE_FIXTURE_FILE is not set");
  return file;
}
const fixtureFile = fixturePath();

function isSourceFixture(value: unknown): value is SourceFixture {
  return (
    isRecord(value) &&
    isRecord(value.imdb) &&
    isRecord(value.trakt) &&
    isRecord(value.titles)
  );
}

function fixture() {
  return parseJson(
    readFileSync(fixtureFile, "utf8"),
    isSourceFixture,
    "Source list fixture",
  );
}

function isImdbVariables(value: unknown): value is {
  urConst?: string;
  after?: string | null;
  ids?: string[];
} {
  return (
    isRecord(value) &&
    optional(value.urConst, isString) &&
    optional(value.after, (after) => after === null || isString(after)) &&
    optional(value.ids, (ids) => Array.isArray(ids) && ids.every(isString))
  );
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

function imdb({ request, body }: FixtureRequest) {
  const { operation, variables } = graphql(body, isImdbVariables);
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
  unsupported(request, `Unexpected IMDb operation ${operation}`);
}

function trakt({ request, url }: FixtureRequest) {
  const user = /^\/users\/([^/]+)\/watchlist$/.exec(url.pathname)?.[1];
  if (request.method !== "GET" || !user) {
    unsupported(request, "Unexpected Trakt request");
  }
  const list = fixture().trakt[user];
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

function cinemetaWithoutTitles({ request, url }: FixtureRequest) {
  if (
    request.method !== "GET" ||
    !/^\/meta\/(?:movie|series)\/tt\d+\.json$/u.test(url.pathname)
  ) {
    unsupported(request, "Unexpected Cinemeta request");
  }
  return new Response("Not found", { status: 404 });
}

installFetchFixture({
  log: process.env.E2E_PROVIDER_LOG,
  hosts: {
    "api.graphql.imdb.com": imdb,
    "api.trakt.tv": trakt,
    "v3-cinemeta.strem.io": cinemetaWithoutTitles,
    "auth.trakt.tv": ({ request, url }) =>
      request.method === "POST" && url.pathname === "/oauth/revoke"
        ? Response.json({})
        : unsupported(request, "Unexpected Trakt OAuth request"),
  },
});
