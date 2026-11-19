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
  if (bearer(request) !== "fixture-access-token") {
    unsupported(request, "Request without the fixture access token");
  }
  if (request.method === "POST" && url.pathname === "/sync/history") {
    return json({ added: { movies: 1, episodes: 1 }, not_found: {} });
  }
  if (
    request.method === "GET" &&
    /^\/sync\/history\/(?:movies|episodes)$/u.test(url.pathname)
  ) {
    return json([]);
  }
  if (
    request.method === "GET" &&
    ["/users/me/lists", "/users/me/smart-lists"].includes(url.pathname)
  ) {
    return json([]);
  }
  unsupported(request, "Unexpected Trakt or Simkl request");
}

function mdblist({ request, url }: FixtureRequest) {
  if (bearer(request) !== "fixture-access-token") {
    unsupported(request, "Request without the fixture access token");
  }
  if (request.method === "POST" && url.pathname === "/sync/watched") {
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
