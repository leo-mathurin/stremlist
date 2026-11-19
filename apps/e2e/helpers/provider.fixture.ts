import type { FixtureRequest } from "./fetch.fixture.js";
import {
  bearer,
  graphql,
  installFetchFixture,
  unsupported,
} from "./fetch.fixture.js";
import { isNumber, isRecord, isString, optional, present } from "./json.js";
import {
  PREVIEW_PRIVATE_LIST,
  PREVIEW_PRODUCTS,
  PREVIEW_PUBLIC_LIST,
} from "./preview.fixture.js";

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
  ...PREVIEW_PRODUCTS.flatMap<[string, ImdbTitle]>(({ imdb, year }) =>
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
const traktRatings = {
  movies: [
    {
      rated_at: "2026-01-01T00:00:00.000Z",
      rating: 9,
      type: "movie",
      movie: traktMovie,
    },
  ],
  shows: [
    {
      rated_at: "2026-01-02T00:00:00.000Z",
      rating: 8,
      type: "show",
      show: traktShow,
    },
  ],
};
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

function syncWrite(body: unknown, known: readonly string[]) {
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

function imdbIdOf(item: unknown) {
  return isRecord(item) && isRecord(item.ids) && isString(item.ids.imdb)
    ? item.ids.imdb
    : "";
}

const SIMKL_KNOWN = ["tt0111161", "tt0903747", "tt0068646"];
const MDBLIST_KNOWN = ["tt0111161", "tt0903747"];

function form(body: unknown) {
  return Object.fromEntries(
    Object.entries(isRecord(body) ? body : {}).filter(
      (field): field is [string, string] => isString(field[1]),
    ),
  );
}

function requireToken(request: Request) {
  const token = bearer(request);
  if (!token || !VALID_TOKENS.has(token)) {
    unsupported(request, "Request without a fixture access token");
  }
}

function tokenResponse(request: Request, body: Record<string, string>) {
  if (body.grant_type === "authorization_code") {
    if (body.code !== "fixture-code" || !body.code_verifier) {
      unsupported(request, "Code exchange without the fixture code");
    }
    return json({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 7_776_000,
      scope: "public",
    });
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
  unsupported(request, `Unexpected grant type ${body.grant_type}`);
}

function traktCalendar(name: string) {
  if (name.startsWith("shows")) {
    return json(
      [1, 2].map((number) => ({
        first_aired: `2026-01-0${number}T02:00:00.000Z`,
        episode: { season: 2, number, ids: { trakt: 30 + number } },
        show: traktShow,
      })),
    );
  }
  return json([{ released: "2026-01-01", movie: traktMovie }]);
}

function trakt({ request, url, body }: FixtureRequest) {
  const path = url.pathname;
  if (url.host === "auth.trakt.tv") {
    if (path === "/oauth/token") return tokenResponse(request, form(body));
    if (path === "/oauth/revoke") return json({});
    unsupported(request, "Unexpected Trakt OAuth request");
  }
  if (request.headers.get("trakt-api-key") !== "fixture-trakt-client") {
    unsupported(request, "Trakt request without the fixture client ID");
  }
  switch (path) {
    case "/users/fixture-user":
      return json({ username: "fixture-user", ids: { slug: "fixture-user" } });
    case "/users/private-user":
      return json({ error: "private" }, 401);
    case "/users/fixture-user/watchlist":
      return json(url.searchParams.has("sort_by") ? traktEntries : []);
    case "/users/fixture-user/ratings":
      return json([]);
    case "/users/fixture-user/ratings/movies":
      return json(traktRatings.movies);
    case "/users/fixture-user/ratings/shows":
      return json(traktRatings.shows);
    case "/movies/trending":
      return json([{ watchers: 9, movie: traktMovie }]);
    case "/shows/trending":
      return json([{ watchers: 7, show: traktShow }]);
    case "/movies/popular":
      return json([traktMovie]);
    case "/shows/popular":
      return json([traktShow]);
    case "/movies/watched/weekly":
      return json([{ watcher_count: 9, play_count: 9, movie: traktMovie }]);
    case "/shows/watched/weekly":
      return json([{ watcher_count: 7, play_count: 7, show: traktShow }]);
  }
  const calendar = /^\/calendars\/(all|my)\/(.+)\/\d{4}-\d{2}-\d{2}\/30$/.exec(
    path,
  );
  if (calendar?.[1] === "all") return traktCalendar(calendar[2]);
  requireToken(request);
  if (calendar) return traktCalendar(calendar[2]);
  switch (path) {
    case "/users/settings":
      return json({
        user: { username: "fixture-user", ids: { slug: "fixture-user" } },
      });
    case "/users/me/watchlist":
      return json(url.searchParams.has("sort_by") ? traktEntries : []);
    case "/users/me/favorites":
      return json(url.searchParams.has("sort_by") ? traktEntries : []);
    case "/users/me/ratings/movies":
      return json(traktRatings.movies);
    case "/users/me/ratings/shows":
      return json(traktRatings.shows);
    case "/users/me/lists":
      return json([{ name: "Fixture List", ids: { slug: "fixture-list" } }]);
    case "/users/me/smart-lists":
      return json([
        {
          name: "Fixture Smart List",
          media_type: "movies",
          ids: { slug: "fixture-smart-list", trakt: 1 },
        },
      ]);
    case "/recommendations/movies":
      return json([traktMovie]);
    case "/recommendations/shows":
      return json([traktShow]);
    case "/sync/progress/up_next":
      return json({ error: "forbidden" }, 403);
    case "/users/likes/lists":
      return json([
        {
          liked_at: "2026-01-01T00:00:00.000Z",
          type: "list",
          list: {
            name: "Fixture Liked List",
            ids: { slug: "liked-list", trakt: 3 },
            user: { ids: { slug: "other-user" } },
          },
        },
      ]);
    case "/users/me/lists/collaborations":
      return json([
        {
          name: "Fixture Shared Work",
          ids: { slug: "shared-work", trakt: 4 },
          user: { ids: { slug: "other-user" } },
        },
      ]);
    case "/sync/playback/movies":
      return json([
        {
          progress: 25,
          paused_at: "2026-01-01T00:00:00.000Z",
          type: "movie",
          movie: traktMovie,
        },
      ]);
    case "/sync/playback/episodes":
      return json(
        [2, 1].map((number) => ({
          progress: 40,
          paused_at: `2026-01-0${number + 1}T00:00:00.000Z`,
          type: "episode",
          episode: { season: 1, number, ids: { trakt: 20 + number } },
          show: traktShow,
        })),
      );
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
      return json(
        {
          added: { movies: 1, shows: 0 },
          existing: { movies: 0, shows: 0 },
          not_found: { movies: [], shows: [], episodes: [] },
        },
        201,
      );
  }
  unsupported(request, "Unexpected Trakt request");
}

function mdblist({ request, url, body }: FixtureRequest) {
  const path = url.pathname;
  if (path === "/oauth/token/") return tokenResponse(request, form(body));
  if (path === "/oauth/revoke_token/") return json({});
  requireToken(request);
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
      return json({ movies: [], shows: [], episodes: [] });
    case "/lists/fixture-user/weekend":
    case "/lists/4242":
      return json({ id: 4242, name: "Weekend", mediatype: null });
    case "/lists/4242/items":
    case "/lists/official/trending/items":
    case "/watchlist/items":
      return json(mdblistItems);
    case "/lists/user":
      return json([{ id: 77, name: "Horror nights", mediatype: "movie" }]);
    case "/lists/liked":
      return json({
        lists: [{ id: 4242, name: "Weekend", mediatype: null }],
        pagination: { offset: 0, total: 1, has_more: false },
      });
    case "/external/lists/user":
      return json([]);
    case "/lists/recommended":
      return json({
        sections: [
          {
            slug: "rising",
            label: "Rising Fast",
            items_url: "/lists/recommended/rising/items",
          },
        ],
      });
  }
  unsupported(request, "Unexpected MDBList request");
}

function simkl({ request, url, body }: FixtureRequest) {
  const path = url.pathname;
  if (path === "/oauth2/token") return tokenResponse(request, form(body));
  if (path === "/oauth2/revoke") return json({});
  if (url.searchParams.get("client_id") !== "fixture-simkl-client") {
    unsupported(request, "Simkl request without the fixture client ID");
  }
  requireToken(request);
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
            user_rating: 8,
            user_rated_at: "2026-01-03T00:00:00Z",
            show: {
              title: BREAKING_BAD.title,
              ids: { simkl: 2, imdb: "tt0903747" },
            },
          },
        ],
      });
    case "/sync/all-items/anime":
      return json({});
    case "/sync/playback":
      return json([
        {
          id: 1,
          progress: 40,
          paused_at: "2026-01-04T00:00:00Z",
          type: "episode",
          episode: { season: 1, number: 2 },
          show: {
            title: BREAKING_BAD.title,
            ids: { simkl: 2, imdb: "tt0903747" },
          },
        },
      ]);
    case "/sync/add-to-list":
    case "/sync/history":
    case "/sync/history/remove":
    case "/sync/ratings":
    case "/sync/ratings/remove":
      if (request.method === "POST") return syncWrite(body, SIMKL_KNOWN);
  }
  unsupported(request, "Unexpected Simkl request");
}

function simklCdn({ request, url }: FixtureRequest) {
  if (url.searchParams.get("client_id") !== "fixture-simkl-client") {
    unsupported(request, "Simkl request without the fixture client ID");
  }
  const ids = (simkl: number, imdb: string) => ({ simkl_id: simkl, imdb });
  switch (url.pathname) {
    case "/discover/trending/movies/week_100.json":
      return json([{ title: SHAWSHANK.title, ids: ids(1, "tt0111161") }]);
    case "/discover/trending/tv/week_100.json":
      return json([{ title: BREAKING_BAD.title, ids: ids(2, "tt0903747") }]);
    case "/discover/trending/anime/week_100.json":
      return json([
        { title: "Season 2", anime_type: "tv", ids: ids(3, "tt0903747") },
        { title: "Season 1", anime_type: "tv", ids: ids(4, "tt0903747") },
      ]);
    case "/discover/trending/movies/today_100.json":
    case "/discover/dvd/releases_100.json":
      return json([{ title: SHAWSHANK.title, ids: ids(1, "tt0111161") }]);
    case "/discover/trending/tv/genre/index.json":
      return json([{ name: "Drama", slug: "drama", count: 500 }]);
    case "/discover/trending/tv/genre/drama_month_500.json":
      return json([{ title: BREAKING_BAD.title, ids: ids(2, "tt0903747") }]);
    case "/calendar/v2/movie_release.json":
      return json({
        calendar: [
          {
            simkl_id: 1,
            date: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
        metadata: { "1": { title: SHAWSHANK.title, ids: ids(1, "tt0111161") } },
      });
  }
  unsupported(request, "Unexpected Simkl CDN request");
}

const JUSTWATCH_LIST = "tl-us-11111111-2222-4333-8444-555555555555";
const JUSTWATCH_MISSING_LIST = "tl-us-99999999-2222-4333-8444-555555555555";

function justwatch({ request, url, body }: FixtureRequest) {
  if (request.method !== "POST" || url.pathname !== "/graphql") {
    unsupported(request, "Unexpected JustWatch request");
  }
  const { operation, variables } = graphql(
    body,
    (value): value is { id?: string } =>
      isRecord(value) && optional(value.id, isString),
  );
  if (operation !== "StremlistJustwatchList") {
    unsupported(request, `Unexpected JustWatch operation ${operation}`);
  }
  if (variables.id === JUSTWATCH_MISSING_LIST) {
    return json({ data: { node: null } });
  }
  if (variables.id !== JUSTWATCH_LIST) {
    unsupported(request, `Unexpected JustWatch list ${variables.id}`);
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

function senscritiqueList(
  request: Request,
  variables: { id?: number; offset?: number },
) {
  const { offset = 0 } = variables;
  const id = present(variables.id, "the ID of the SensCritique list");
  if (id === PREVIEW_PRIVATE_LIST) {
    return json({ data: { userList: { id, isPrivate: true } } });
  }
  if (id < PREVIEW_PUBLIC_LIST || id >= PREVIEW_PUBLIC_LIST + 1000) {
    unsupported(request, `Unexpected SensCritique list ${id}`);
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
  action?: string;
} {
  return (
    isRecord(value) &&
    optional(value.id, isNumber) &&
    optional(value.offset, isNumber) &&
    optional(value.username, isString) &&
    optional(value.universe, isString) &&
    optional(value.action, isString)
  );
}

function senscritique({ request, url, body }: FixtureRequest) {
  if (request.method !== "POST" || url.pathname !== "/") {
    unsupported(request, "Unexpected SensCritique request");
  }
  const { operation, variables } = graphql(body, isSensCritiqueVariables);
  if (operation === "StremlistList") {
    return senscritiqueList(request, variables);
  }
  if (variables.username === "private-user") {
    return json({
      data: {
        user: { username: "private-user", settings: { privacyProfile: true } },
      },
    });
  }
  if (variables.username !== "fixture-user") {
    unsupported(request, `Unexpected SensCritique user ${variables.username}`);
  }
  const user = {
    username: "fixture-user",
    settings: { privacyProfile: false },
  };
  if (operation === "StremlistUser") return json({ data: { user } });
  if (operation !== "StremlistCollection") {
    unsupported(request, `Unexpected SensCritique operation ${operation}`);
  }
  if (
    !["WISH", "DONE", "RATING", "RECOMMEND"].includes(variables.action ?? "")
  ) {
    unsupported(request, `Unexpected SensCritique action ${variables.action}`);
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

function letterboxd({ request, url }: FixtureRequest) {
  if (
    request.method !== "GET" ||
    request.headers.has("cookie") ||
    request.headers.has("authorization")
  ) {
    unsupported(request, "Letterboxd reads must be anonymous GETs");
  }
  if (
    url.pathname !== "/fixture_user/watchlist/" &&
    url.pathname !== "/fixture_user/list/weekend/"
  ) {
    unsupported(request, "Unexpected Letterboxd page");
  }
  const films = [
    [101, "The Shawshank Redemption", 1994],
    [202, "Breaking Bad", 2008],
  ];
  return new Response(
    `<html><head><title>Fixture • Letterboxd</title></head><body><h1>Weekend</h1><ul class="poster-list -grid">${films.map(([id, title, year]) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="fixture-${id}" data-item-name="${title} (${year})"></li>`).join("")}</ul></body></html>`,
  );
}

function wikidata({ request, url, body }: FixtureRequest) {
  if (request.method !== "POST" || url.pathname !== "/sparql") {
    unsupported(request, "Unexpected Wikidata request");
  }
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

function imdb({ request, url, body }: FixtureRequest) {
  if (request.method !== "POST" || url.pathname !== "/") {
    unsupported(request, "Unexpected IMDb request");
  }
  const { operation, variables } = graphql(
    body,
    (value): value is { ids: string[] } =>
      isRecord(value) && Array.isArray(value.ids) && value.ids.every(isString),
  );
  if (operation !== "TitlesById") {
    unsupported(request, `Unexpected IMDb operation ${operation}`);
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
              ...(process.env.E2E_IMDB_POSTERS && {
                primaryImage: { url: imdbPosterOf(id) },
              }),
            }
          : null;
      }),
    },
  });
}

function imdbPosterOf(imdbId: string) {
  return `https://m.media-amazon.com/images/M/fixture-${imdbId}.jpg`;
}

const TMDB_POSTER_PATHS = new Map([["tt0111161", "/fixture-shawshank.jpg"]]);

function tmdb({ request, url }: FixtureRequest) {
  const found = /^\/3\/find\/(tt\d+)$/u.exec(url.pathname);
  if (
    request.method !== "GET" ||
    !found ||
    url.searchParams.get("external_source") !== "imdb_id"
  ) {
    unsupported(request, "Unexpected TMDB request");
  }
  const status = Number(process.env.E2E_TMDB_STATUS);
  if (status) return json({ status_message: "fixture outage" }, status);
  const path = TMDB_POSTER_PATHS.get(found[1]);
  return json({
    movie_results: path ? [{ id: 278, poster_path: path }] : [],
    tv_results:
      found[1] === "tt0903747" ? [{ id: 1396, poster_path: null }] : [],
  });
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
  passthrough: process.env.TVDB_API_KEY ? ["api4.thetvdb.com"] : [],
  hosts: {
    "letterboxd.com": letterboxd,
    "api.trakt.tv": trakt,
    "auth.trakt.tv": trakt,
    "api.mdblist.com": mdblist,
    "api.simkl.com": simkl,
    "data.simkl.in": simklCdn,
    "apis.justwatch.com": justwatch,
    "apollo.senscritique.com": senscritique,
    "query.wikidata.org": wikidata,
    "api.graphql.imdb.com": imdb,
    "api.themoviedb.org": tmdb,
    "v3-cinemeta.strem.io": cinemetaWithoutTitles,
  },
});
