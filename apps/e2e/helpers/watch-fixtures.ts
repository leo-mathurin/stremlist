// Loaded only by the isolated backend of watch-tracking.spec.ts. Stremio's
// API answers from the JSON file at E2E_WATCH_STREMIO, which the test
// rewrites to change the member's library; the backend never sees a real
// Stremio account. Trakt and Simkl accept watched writes. Every request is
// logged to E2E_PROVIDER_LOG (see fetch-fixture.ts); any other host is
// refused.
import { readFileSync, writeFileSync } from "node:fs";
import type { FixtureRequest } from "./fetch-fixture.js";
import { bearer, installFetchFixture } from "./fetch-fixture.js";
import { isFakeStremio } from "./fake-stremio.js";
import { parseJson } from "./json.js";

const json = (body: unknown, status = 200) => Response.json(body, { status });

function stremioFile(): string {
  const file = process.env.E2E_WATCH_STREMIO;
  if (!file) throw new Error("E2E_WATCH_STREMIO is not set");
  return file;
}

function stremio({ url, body }: FixtureRequest): Response {
  const state = parseJson(
    readFileSync(stremioFile(), "utf8"),
    isFakeStremio,
    "fake Stremio",
  );
  const request = (body ?? {}) as {
    authKey?: string;
    ids?: string[];
    addons?: Record<string, unknown>[];
  };
  if (request.authKey !== state.authKey) {
    return json({ error: { code: 1, message: "Session does not exist" } });
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
          (request.ids ?? []).includes(String(item._id)),
        ),
      });
    case "/api/addonCollectionGet":
      return json({ result: { addons: state.addons } });
    case "/api/addonCollectionSet":
      writeFileSync(
        stremioFile(),
        JSON.stringify({ ...state, addons: request.addons ?? [] }),
      );
      return json({ result: { success: true } });
    default:
      return json({ error: { code: 0, message: "Unknown method" } }, 404);
  }
}

/** Breaking Bad's first season, as Cinemeta lists it. */
function cinemeta({ url }: FixtureRequest): Response {
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

function provider({ request, url }: FixtureRequest): Response {
  if (bearer(request) !== "fixture-access-token") {
    return json({ error: "invalid_token" }, 401);
  }
  if (request.method === "POST" && url.pathname === "/sync/history") {
    return json({ added: { movies: 1, episodes: 1 }, not_found: {} });
  }
  if (url.pathname.startsWith("/sync/history/")) return json([]);
  // Membership refreshes after a write: nothing else is known.
  return json({ error: "not found" }, 404);
}

installFetchFixture({
  log: process.env.E2E_PROVIDER_LOG,
  hosts: {
    "api.strem.io": stremio,
    "v3-cinemeta.strem.io": cinemeta,
    "api.trakt.tv": provider,
    "api.simkl.com": provider,
  },
});
