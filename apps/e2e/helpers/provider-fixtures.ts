// Loaded only by the isolated Provider backends of the provider-*.spec.ts files
// and catalog-preview.spec.ts (the synthetic list of preview-fixture.ts).
// The real adapters, OAuth flow, ID resolver, database and R2 code run; every
// outbound request to a Provider is answered here with deterministic data.
// Loopback requests (the local Supabase stack) use the real fetch. Any other
// destination is refused: no request ever reaches a real Provider, and no
// credential exists in this process. Each Provider request is appended as one
// JSON line to E2E_PROVIDER_LOG, so tests can check what the backend sent.
import type { FixtureRequest } from "./fetch-fixture.js";
import { bearer, graphql, installFetchFixture } from "./fetch-fixture.js";
import { isNumber, isRecord, isString, optional, present } from "./json.js";
import {
  PREVIEW_PRIVATE_LIST,
  PREVIEW_PRODUCTS,
  PREVIEW_PUBLIC_LIST,
} from "./preview-fixture.js";

/** Tokens the fixtures accept: seeded Connections and fresh exchanges. */
const VALID_TOKENS = new Set(["fixture-access-token", "fresh-access"]);

const SHAWSHANK = { title: "The Shawshank Redemption", year: 1994 };
const BREAKING_BAD = { title: "Breaking Bad", year: 2008 };
interface ImdbTitle {
  text: string;
  type: string;
  year: number;
  rating?: number;
}
const IMDB_TITLES = new Map<string, ImdbTitle>([
  ["tt0111161", { text: SHAWSHANK.title, type: "Movie", year: SHAWSHANK.year }],
  [
    "tt0903747",
    { text: BREAKING_BAD.title, type: "TV Series", year: BREAKING_BAD.year },
  ],
  ...PREVIEW_PRODUCTS.flatMap(({ imdb, year }): [string, ImdbTitle][] =>
    imdb
      ? [
          [
            imdb.id,
            { text: imdb.title, type: "Movie", year, rating: imdb.rating },
          ],
        ]
      : [],
  ),
]);

const traktMovie = { ...SHAWSHANK, ids: { trakt: 1, imdb: "tt0111161" } };
const traktShow = { ...BREAKING_BAD, ids: { trakt: 2, imdb: "tt0903747" } };
const traktEntries = [
  { type: "movie", listed_at: "2026-01-01T00:00:00.000Z", movie: traktMovie },
  { type: "show", listed_at: "2026-01-02T00:00:00.000Z", show: traktShow },
];
const mdblistItems = [
  { mediatype: "movie", ids: { imdb: "tt0111161", tmdb: 278 } },
  { mediatype: "show", ids: { imdb: "tt0903747", tmdb: 1396 } },
];

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

/**
 * The answer of a Simkl or MDBList Action write (the Trakt-style /sync
 * body): every Title of `known` is written, the others are not found.
 */
function syncWrite(body: unknown, known: readonly string[]): Response {
  const notFound = (bucket: "movies" | "shows") => {
    const items = isRecord(body) ? body[bucket] : undefined;
    const list: unknown[] = Array.isArray(items) ? items : [];
    return list.filter((item) => !known.includes(imdbIdOf(item)));
  };
  return json(
    {
      added: { movies: 1, shows: 0 },
      not_found: { movies: notFound("movies"), shows: notFound("shows") },
    },
    201,
  );
}

/** The IMDb ID of an item of a /sync body, or "". */
function imdbIdOf(item: unknown): string {
  return isRecord(item) && isRecord(item.ids) && isString(item.ids.imdb)
    ? item.ids.imdb
    : "";
}

/** Titles the Simkl and MDBList fixtures know (MDBList: no Godfather). */
const SIMKL_KNOWN = ["tt0111161", "tt0903747", "tt0068646"];
const MDBLIST_KNOWN = ["tt0111161", "tt0903747"];

/** The fields of a form-encoded request (token exchanges, SPARQL). */
function form(body: unknown) {
  return Object.fromEntries(
    Object.entries(isRecord(body) ? body : {}).filter(
      (field): field is [string, string] => isString(field[1]),
    ),
  );
}

/** 401 unless the request carries a token that the fixtures issued. */
function requireToken(request: Request): Response | null {
  const token = bearer(request);
  return token && VALID_TOKENS.has(token)
    ? null
    : json({ error: "invalid_token" }, 401);
}

function tokenResponse(body: Record<string, string>): Response {
  if (body.grant_type === "authorization_code") {
    return body.code === "fixture-code" && body.code_verifier
      ? json({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 7_776_000,
          scope: "public",
        })
      : json({ error: "invalid_grant" }, 400);
  }
  if (body.grant_type === "refresh_token") {
    return body.refresh_token === "rejected-refresh"
      ? json({ error: "invalid_grant" }, 401)
      : json({
          access_token: "fresh-access",
          refresh_token: "rotated-refresh",
          expires_in: 7_776_000,
        });
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

function trakt({ request, url, body }: FixtureRequest): Response {
  const path = url.pathname;
  if (url.host === "auth.trakt.tv") {
    if (path === "/oauth/token") return tokenResponse(form(body));
    if (path === "/oauth/revoke") return json({});
  }
  if (request.headers.get("trakt-api-key") !== "fixture-trakt-client") {
    return json({ error: "missing client id" }, 403);
  }
  switch (path) {
    case "/users/fixture-user":
      return json({ username: "fixture-user", ids: { slug: "fixture-user" } });
    case "/users/private-user":
      return json({ error: "private" }, 401);
    case "/users/fixture-user/watchlist":
      return json(url.searchParams.has("sort_by") ? traktEntries : []);
    // Charts: trending rows wrap the media, popular rows are the media.
    case "/movies/trending":
      return json([{ watchers: 9, movie: traktMovie }]);
    case "/shows/trending":
      return json([{ watchers: 7, show: traktShow }]);
    case "/movies/popular":
      return json([traktMovie]);
    case "/shows/popular":
      return json([traktShow]);
  }
  const refused = requireToken(request);
  if (refused) return refused;
  switch (path) {
    case "/users/settings":
      return json({
        user: { username: "fixture-user", ids: { slug: "fixture-user" } },
      });
    case "/users/me/watchlist":
      return json(url.searchParams.has("sort_by") ? traktEntries : []);
    case "/users/me/lists":
      return json([{ name: "Fixture List", ids: { slug: "fixture-list" } }]);
    // The Source lists that only a Connection reads.
    case "/recommendations/movies":
      return json([traktMovie]);
    case "/recommendations/shows":
      return json([traktShow]);
    case "/sync/progress/up_next":
      // A limited-access endpoint: the adapter reads the watched progress.
      return json({ error: "forbidden" }, 403);
    case "/sync/progress/watched":
      return json([
        {
          show: traktShow,
          progress: { last_watched_at: "2026-01-03T00:00:00.000Z" },
        },
      ]);
    case "/users/me/watched/movies":
      return json([
        { last_watched_at: "2026-01-01T00:00:00.000Z", movie: traktMovie },
      ]);
    case "/users/me/watched/shows":
      return json([
        { last_watched_at: "2026-01-02T00:00:00.000Z", show: traktShow },
      ]);
    case "/sync/collection/movies":
      return json([
        { collected_at: "2026-01-01T00:00:00.000Z", movie: traktMovie },
      ]);
    case "/sync/collection/shows":
      return json([
        { last_collected_at: "2026-01-02T00:00:00.000Z", show: traktShow },
      ]);
    case "/sync/watched/movies":
    case "/sync/watched/shows":
    case "/sync/ratings/movies":
    case "/sync/ratings/shows":
      return json([]);
    case "/sync/watchlist":
    case "/sync/watchlist/remove":
    case "/sync/history":
    case "/sync/history/remove":
    case "/sync/ratings":
    case "/sync/ratings/remove":
      // Every Action write: Trakt knows both fixture Titles.
      return json(
        {
          added: { movies: 1, shows: 0 },
          existing: { movies: 0, shows: 0 },
          not_found: { movies: [], shows: [], episodes: [] },
        },
        201,
      );
  }
  throw new Error(`Unexpected Trakt request ${request.method} ${path}`);
}

function mdblist({ request, url, body }: FixtureRequest): Response {
  const path = url.pathname;
  if (path === "/oauth/token/") return tokenResponse(form(body));
  if (path === "/oauth/revoke_token/") return json({});
  const refused = requireToken(request);
  if (refused) return refused;
  if (request.method === "POST") {
    switch (path) {
      case "/watchlist/items/add":
      case "/watchlist/items/remove":
      case "/sync/watched":
      case "/sync/watched/remove":
      case "/sync/ratings":
      case "/sync/ratings/remove":
        return syncWrite(body, MDBLIST_KNOWN);
    }
  }
  switch (path) {
    case "/user":
      return json({ username: "fixture-user" });
    case "/sync/watched":
    case "/sync/ratings":
      // The Action membership: nothing watched or rated yet.
      return json({ movies: [], shows: [], episodes: [] });
    case "/lists/fixture-user/weekend":
    case "/lists/4242":
      return json({ id: 4242, name: "Weekend", mediatype: null });
    case "/lists/4242/items":
    case "/watchlist/items":
      return json(mdblistItems);
    case "/lists/user":
      return json([{ id: 77, name: "Horror nights", mediatype: "movie" }]);
    case "/external/lists/user":
      return json([]);
  }
  throw new Error(`Unexpected MDBList request ${request.method} ${path}`);
}

function simkl({ request, url, body }: FixtureRequest): Response {
  const path = url.pathname;
  if (path === "/oauth2/token") return tokenResponse(form(body));
  if (path === "/oauth2/revoke") return json({});
  if (url.searchParams.get("client_id") !== "fixture-simkl-client") {
    return json({ error: "missing client id" }, 403);
  }
  const refused = requireToken(request);
  if (refused) return refused;
  switch (path) {
    case "/users/settings":
      return json({ user: { name: "fixture-user" } });
    case "/sync/activities":
      return json({ all: "2026-01-02T00:00:00Z" });
    case "/sync/all-items/movies":
      return json({
        movies: [
          {
            status: "plantowatch",
            added_to_watchlist_at: "2026-01-01T00:00:00Z",
            movie: {
              title: SHAWSHANK.title,
              ids: { simkl: 1, imdb: "tt0111161" },
            },
          },
        ],
      });
    case "/sync/all-items/shows":
      return json({
        shows: [
          {
            status: "plantowatch",
            added_to_watchlist_at: "2026-01-02T00:00:00Z",
            show: {
              title: BREAKING_BAD.title,
              ids: { simkl: 2, imdb: "tt0903747" },
            },
          },
        ],
      });
    case "/sync/all-items/anime":
      return json({});
    case "/sync/add-to-list":
    case "/sync/history":
    case "/sync/history/remove":
    case "/sync/ratings":
    case "/sync/ratings/remove":
      if (request.method === "POST") return syncWrite(body, SIMKL_KNOWN);
  }
  throw new Error(`Unexpected Simkl request ${request.method} ${path}`);
}

function justwatch({ body }: FixtureRequest): Response {
  const { operation, variables } = graphql(
    body,
    (value): value is { id?: string } =>
      isRecord(value) && optional(value.id, isString),
  );
  if (operation !== "StremlistJustwatchList") {
    throw new Error(`Unexpected JustWatch operation ${operation}`);
  }
  if (variables.id !== "tl-us-11111111-2222-4333-8444-555555555555") {
    return json({ data: { node: null } });
  }
  return json({
    data: {
      node: {
        __typename: "GenericTitleList",
        id: variables.id,
        type: "USER_LIST",
        visibility: "UNLISTED",
        name: "Weekend picks",
        content: { name: "Weekend picks" },
        titles: {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            {
              node: {
                id: "tm1111",
                objectType: "MOVIE",
                content: {
                  title: SHAWSHANK.title,
                  originalReleaseYear: SHAWSHANK.year,
                  externalIds: { imdbId: "tt0111161", tmdbId: "278" },
                },
              },
            },
            {
              node: {
                id: "ts2222",
                objectType: "SHOW",
                content: {
                  title: BREAKING_BAD.title,
                  originalReleaseYear: BREAKING_BAD.year,
                  externalIds: { imdbId: "tt0903747", tmdbId: "1396" },
                },
              },
            },
          ],
        },
      },
    },
  });
}

/** A user list of the Catalog preview tests (preview-fixture.ts). */
function senscritiqueList(variables: { id?: number; offset?: number }) {
  const { offset = 0 } = variables;
  const id = present(variables.id, "the ID of the SensCritique list");
  if (id === PREVIEW_PRIVATE_LIST) {
    return json({ data: { userList: { id, isPrivate: true } } });
  }
  // Every other ID of the fixture range is the same public list, so a test
  // can ask for a list that the backend did not read yet.
  if (id < PREVIEW_PUBLIC_LIST || id >= PREVIEW_PUBLIC_LIST + 1000) {
    throw new Error(`Unexpected SensCritique list ${id}`);
  }
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
  return json({
    data: {
      userList: {
        id,
        isPrivate: false,
        productsList: { total: PREVIEW_PRODUCTS.length, items },
      },
    },
  });
}

function isSensCritiqueVariables(value: unknown): value is {
  id?: number;
  offset?: number;
  username?: string;
  universe?: string;
} {
  return (
    isRecord(value) &&
    optional(value.id, isNumber) &&
    optional(value.offset, isNumber) &&
    optional(value.username, isString) &&
    optional(value.universe, isString)
  );
}

function senscritique({ body }: FixtureRequest): Response {
  const { operation, variables } = graphql(body, isSensCritiqueVariables);
  if (operation === "StremlistList") return senscritiqueList(variables);
  if (variables.username === "private-user") {
    return json({
      data: {
        user: { username: "private-user", settings: { privacyProfile: true } },
      },
    });
  }
  if (variables.username !== "fixture-user")
    return json({ data: { user: null } });
  const user = {
    username: "fixture-user",
    settings: { privacyProfile: false },
  };
  if (operation === "StremlistUser") return json({ data: { user } });
  if (operation !== "StremlistWishes") {
    throw new Error(`Unexpected SensCritique operation ${operation}`);
  }
  const products =
    variables.universe === "movie"
      ? [
          {
            id: 101,
            title: "Les Évadés",
            originalTitle: SHAWSHANK.title,
            dateReleaseOriginal: "1994-09-23",
            duration: 8520,
            universe: 1,
            directors: [{ name: "Frank Darabont" }],
            creators: [],
            providers: [],
            otherUserInfos: { id: 1 },
          },
        ]
      : [
          {
            id: 202,
            title: BREAKING_BAD.title,
            originalTitle: BREAKING_BAD.title,
            dateReleaseOriginal: "2008-01-20",
            universe: 4,
            directors: [],
            creators: [{ name: "Vince Gilligan" }],
            providers: [],
            otherUserInfos: { id: 2 },
          },
        ];
  return json({
    data: { user: { ...user, collection: { total: 1, products } } },
  });
}

function letterboxd({ request, url }: FixtureRequest): Response {
  if (
    request.method !== "GET" ||
    request.headers.has("cookie") ||
    request.headers.has("authorization")
  )
    throw new Error("Letterboxd reads must be anonymous GETs");
  if (
    url.pathname !== "/fixture_user/watchlist/" &&
    url.pathname !== "/fixture_user/list/weekend/"
  )
    return new Response("Not found", { status: 404 });
  const films = [
    [101, "The Shawshank Redemption", 1994],
    [202, "Breaking Bad", 2008],
  ];
  return new Response(
    `<html><head><title>Fixture • Letterboxd</title></head><body><h1>Weekend</h1><ul class="poster-list -grid">${films.map(([id, title, year]) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="fixture-${id}" data-item-name="${title} (${year})"></li>`).join("")}</ul></body></html>`,
  );
}

/** Exact Wikidata links for the Provider fixture entries. */
function wikidata({ body }: FixtureRequest): Response {
  const query = form(body).query ?? "";
  const known = {
    "101": "tt0111161",
    "202": "tt0903747",
    "film:101": "tt0111161",
    "film:202": "tt0903747",
    ...Object.fromEntries(
      PREVIEW_PRODUCTS.flatMap(({ id, imdb }) =>
        imdb ? [[String(id), imdb.id]] : [],
      ),
    ),
  };
  const bindings = Object.entries(known)
    .filter(([id]) => query.includes(`"${id}"`))
    .map(([id, imdb]) => ({
      external: { value: id },
      imdb: { value: imdb },
    }));
  return json({ results: { bindings } });
}

function imdb({ body }: FixtureRequest): Response {
  const { operation, variables } = graphql(
    body,
    (value): value is { ids: string[] } =>
      isRecord(value) && Array.isArray(value.ids) && value.ids.every(isString),
  );
  if (operation !== "TitlesById") {
    throw new Error(`Unexpected IMDb operation ${operation}`);
  }
  return json({
    data: {
      titles: variables.ids.map((id) => {
        const title = IMDB_TITLES.get(id);
        return title
          ? {
              id,
              titleText: { text: title.text },
              titleType: { text: title.type },
              releaseYear: { year: title.year },
              ...(title.rating && {
                ratingsSummary: { aggregateRating: title.rating },
              }),
            }
          : null;
      }),
    },
  });
}

installFetchFixture({
  log: process.env.E2E_PROVIDER_LOG,
  hosts: {
    "letterboxd.com": letterboxd,
    "api.trakt.tv": trakt,
    "auth.trakt.tv": trakt,
    "api.mdblist.com": mdblist,
    "api.simkl.com": simkl,
    "apis.justwatch.com": justwatch,
    "apollo.senscritique.com": senscritique,
    "query.wikidata.org": wikidata,
    "api.graphql.imdb.com": imdb,
  },
});
