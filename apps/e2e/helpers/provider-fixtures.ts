// Loaded only by the isolated Provider backends of provider-journeys.spec.ts
// and catalog-preview.spec.ts (the synthetic list of preview-fixture.ts).
// The real adapters, OAuth flow, ID resolver, database and R2 code run; every
// outbound request to a Provider is answered here with deterministic data.
// Loopback requests (the local Supabase stack) use the real fetch. Any other
// destination is refused: no request ever reaches a real Provider, and no
// credential exists in this process. Each Provider request is appended as one
// JSON line to E2E_PROVIDER_LOG, so tests can check what the backend sent.
import { appendFileSync } from "node:fs";
import {
  PREVIEW_PRIVATE_LIST,
  PREVIEW_PRODUCTS,
  PREVIEW_PUBLIC_LIST,
} from "./preview-fixture.js";

const realFetch = globalThis.fetch;
const LOG = process.env.E2E_PROVIDER_LOG;

/** Tokens the fixtures accept: seeded Connections and fresh exchanges. */
const VALID_TOKENS = new Set(["fixture-access-token", "fresh-access"]);

const SHAWSHANK = { title: "The Shawshank Redemption", year: 1994 };
const BREAKING_BAD = { title: "Breaking Bad", year: 2008 };
const IMDB_TITLES: Record<
  string,
  { text: string; type: string; year: number; rating?: number }
> = {
  tt0111161: { text: SHAWSHANK.title, type: "Movie", year: SHAWSHANK.year },
  tt0903747: {
    text: BREAKING_BAD.title,
    type: "TV Series",
    year: BREAKING_BAD.year,
  },
  ...Object.fromEntries(
    PREVIEW_PRODUCTS.flatMap(({ imdb, year }) =>
      imdb
        ? [
            [
              imdb.id,
              { text: imdb.title, type: "Movie", year, rating: imdb.rating },
            ],
          ]
        : [],
    ),
  ),
};

const traktEntries = [
  {
    type: "movie",
    listed_at: "2026-01-01T00:00:00.000Z",
    movie: { ...SHAWSHANK, ids: { trakt: 1, imdb: "tt0111161" } },
  },
  {
    type: "show",
    listed_at: "2026-01-02T00:00:00.000Z",
    show: { ...BREAKING_BAD, ids: { trakt: 2, imdb: "tt0903747" } },
  },
];
const mdblistItems = [
  { mediatype: "movie", ids: { imdb: "tt0111161", tmdb: 278 } },
  { mediatype: "show", ids: { imdb: "tt0903747", tmdb: 1396 } },
];

interface Logged {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

function log(entry: Logged) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
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

function trakt(request: Request, url: URL, body: unknown): Response {
  const path = url.pathname;
  if (url.host === "auth.trakt.tv") {
    if (path === "/oauth/token")
      return tokenResponse(body as Record<string, string>);
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
    case "/sync/watched/movies":
    case "/sync/watched/shows":
    case "/sync/ratings/movies":
    case "/sync/ratings/shows":
      return json([]);
    case "/sync/watchlist":
      return json(
        {
          added: { movies: 1, shows: 0 },
          existing: { movies: 0, shows: 0 },
          not_found: { movies: [], shows: [] },
        },
        201,
      );
  }
  throw new Error(`Unexpected Trakt request ${request.method} ${path}`);
}

function mdblist(request: Request, url: URL, body: unknown): Response {
  const path = url.pathname;
  if (path === "/oauth/token/")
    return tokenResponse(body as Record<string, string>);
  if (path === "/oauth/revoke_token/") return json({});
  const refused = requireToken(request);
  if (refused) return refused;
  switch (path) {
    case "/user":
      return json({ username: "fixture-user" });
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

function simkl(request: Request, url: URL, body: unknown): Response {
  const path = url.pathname;
  if (path === "/oauth2/token")
    return tokenResponse(body as Record<string, string>);
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
  }
  throw new Error(`Unexpected Simkl request ${request.method} ${path}`);
}

function graphqlOperation(body: unknown): string {
  const { query, operationName } = body as {
    query?: string;
    operationName?: string;
  };
  return operationName ?? /query (\w+)/.exec(query ?? "")?.[1] ?? "";
}

function justwatch(body: unknown): Response {
  const { variables } = body as { variables: { id?: string } };
  if (graphqlOperation(body) !== "StremlistJustwatchList") {
    throw new Error(`Unexpected JustWatch operation ${graphqlOperation(body)}`);
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
function senscritiqueList(variables: { id: number; offset?: number }) {
  const { id, offset = 0 } = variables;
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

function senscritique(body: unknown): Response {
  const operation = graphqlOperation(body);
  if (operation === "StremlistList") {
    return senscritiqueList(
      (body as { variables: { id: number; offset?: number } }).variables,
    );
  }
  const { variables } = body as {
    variables: { username?: string; universe?: string };
  };
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

/** Wikidata maps SensCritique product IDs (P10100) to IMDb IDs. */
function wikidata(body: unknown): Response {
  const query = String((body as { query?: string }).query ?? "");
  const known: Record<string, string> = {
    "101": "tt0111161",
    "202": "tt0903747",
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

function imdb(body: unknown): Response {
  if (graphqlOperation(body) !== "TitlesById") {
    throw new Error(`Unexpected IMDb operation ${graphqlOperation(body)}`);
  }
  const { variables } = body as { variables: { ids: string[] } };
  return json({
    data: {
      titles: variables.ids.map((id) => {
        const title = IMDB_TITLES[id];
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

Object.defineProperty(globalThis, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (["127.0.0.1", "localhost"].includes(url.hostname)) {
      return realFetch(input, init);
    }
    const text = request.method === "GET" ? "" : await request.text();
    const body = parseBody(text, request.headers.get("content-type"));
    log({
      method: request.method,
      url: request.url,
      authorization: bearer(request),
      body,
    });
    switch (url.host) {
      case "api.trakt.tv":
      case "auth.trakt.tv":
        return trakt(request, url, body);
      case "api.mdblist.com":
        return mdblist(request, url, body);
      case "api.simkl.com":
        return simkl(request, url, body);
      case "apis.justwatch.com":
        return justwatch(body);
      case "apollo.senscritique.com":
        return senscritique(body);
      case "query.wikidata.org":
        return wikidata(body);
      case "api.graphql.imdb.com":
        return imdb(body);
    }
    throw new Error(`Provider fixture refuses outbound request to ${url.host}`);
  },
});
