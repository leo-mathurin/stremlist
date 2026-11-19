import { readFileSync, writeFileSync } from "node:fs";
import type { FixtureRequest } from "./fetch.fixture.js";
import { bearer, installFetchFixture, unsupported } from "./fetch.fixture.js";
import { isFakeStremio } from "./fake-stremio.js";
import { parseJson } from "./json.js";

const json = (body: unknown, status = 200) => Response.json(body, { status });

function stremioFile() {
  const file = process.env.E2E_WATCH_STREMIO;
  if (!file) throw new Error("E2E_WATCH_STREMIO is not set");
  return file;
}

function stremio({ request, url, body }: FixtureRequest) {
  if (request.method !== "POST") {
    unsupported(request, "Stremio API calls are POST requests");
  }
  const state = parseJson(
    readFileSync(stremioFile(), "utf8"),
    isFakeStremio,
    "fake Stremio",
  );
  const call = (body ?? {}) as {
    authKey?: string;
    ids?: string[];
    addons?: Record<string, unknown>[];
  };
  if (call.authKey !== state.authKey) {
    unsupported(request, "Stremio request without the fixture session");
  }
  const mtime = (item: Record<string, unknown>) =>
    Date.parse(String(item._mtime));
  switch (url.pathname) {
    case "/api/getUser":
      return json({
        result: {
          email: "member@example.com",
          trakt: state.trakt ? { access_token: "stremio-trakt" } : null,
        },
      });
    case "/api/datastoreMeta":
      return json({ result: state.library.map((i) => [i._id, mtime(i)]) });
    case "/api/datastoreGet":
      return json({
        result: state.library.filter((item) =>
          (call.ids ?? []).includes(String(item._id)),
        ),
      });
    case "/api/addonCollectionGet":
      return json({ result: { addons: state.addons } });
    case "/api/addonCollectionSet":
      writeFileSync(
        stremioFile(),
        JSON.stringify({ ...state, addons: call.addons ?? [] }),
      );
      return json({ result: { success: true } });
    default:
      unsupported(request, "Unexpected Stremio request");
  }
}

function cinemeta({ request, url }: FixtureRequest) {
  if (
    request.method !== "GET" ||
    !/^\/meta\/(?:movie|series)\/tt\d+\.json$/u.test(url.pathname)
  ) {
    unsupported(request, "Unexpected Cinemeta request");
  }
  if (url.pathname !== "/meta/series/tt0903747.json") {
    return json({ meta: null });
  }
  return json({
    meta: {
      id: "tt0903747",
      videos: [1, 2, 3].map((episode) => ({
        id: `tt0903747:1:${episode}`,
        season: 1,
        episode,
        released: `2008-01-${String(19 + episode).padStart(2, "0")}T00:00:00.000Z`,
      })),
    },
  });
}

function provider({ request, url }: FixtureRequest) {
  const outage = process.env.E2E_WATCH_SIMKL_FAILURE;
  if (
    url.host === "api.simkl.com" &&
    outage &&
    readFileSync(outage, "utf8") === "down"
  )
    return json({ error: "Fixture outage" }, 503);
  if (bearer(request) !== "fixture-access-token") {
    unsupported(request, "Request without the fixture access token");
  }
  if (
    request.method === "POST" &&
    [
      "/sync/history",
      "/sync/watchlist",
      "/sync/add-to-list",
      "/watchlist/items/add",
    ].includes(url.pathname)
  ) {
    return json({ added: { movies: 1, episodes: 1 }, not_found: {} });
  }
  if (
    request.method === "GET" &&
    url.hostname === "api.simkl.com" &&
    url.pathname === "/sync/activities"
  )
    return json({ all: null });
  if (
    request.method === "GET" &&
    url.hostname === "api.simkl.com" &&
    /^\/sync\/all-items\/(movies|shows|anime)$/.test(url.pathname)
  )
    return json({ movies: [], shows: [], anime: [] });
  if (
    request.method === "GET" &&
    /^\/sync\/history\/(movies|episodes)$/.test(url.pathname)
  )
    return json([]);
  if (
    request.method === "GET" &&
    [
      "/users/me/lists",
      "/users/me/smart-lists",
      "/users/me/lists/collaborations",
      "/users/likes/lists",
    ].includes(url.pathname)
  )
    return json([]);
  unsupported(request, "Unexpected Trakt or Simkl request");
}

function mdblist({ request, url }: FixtureRequest) {
  if (bearer(request) !== "fixture-access-token") {
    unsupported(request, "Request without the fixture access token");
  }
  if (
    request.method === "POST" &&
    ["/sync/watched", "/watchlist/items/add"].includes(url.pathname)
  ) {
    return json({ added: { movies: 0, episodes: 1 }, not_found: {} });
  }
  unsupported(request, "Unexpected MDBList request");
}

installFetchFixture({
  log: process.env.E2E_PROVIDER_LOG,
  hosts: {
    "api.strem.io": stremio,
    "v3-cinemeta.strem.io": cinemeta,
    "api.trakt.tv": provider,
    "api.simkl.com": provider,
    "api.mdblist.com": mdblist,
  },
});
