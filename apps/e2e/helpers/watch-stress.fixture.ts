import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  bearer,
  installFetchFixture,
  type FixtureRequest,
} from "./fetch.fixture.js";

const config = z.object({
  watched: z.boolean(),
  outage: z.string().nullable(),
});
const stremioRequest = z.object({
  authKey: z.string(),
  ids: z.array(z.string()).optional(),
});
const stateFile = z.string().min(1).parse(process.env.E2E_WATCH_STRESS_STATE);
const receipts = z.string().min(1).parse(process.env.E2E_WATCH_STRESS_RECEIPTS);
if (!stateFile || !receipts)
  throw new Error("Stress fixture files are required");
const state = () => config.parse(JSON.parse(readFileSync(stateFile, "utf8")));
function stremio({ url, body }: FixtureRequest) {
  const input = stremioRequest.parse(body);
  const index = z.coerce
    .number()
    .int()
    .nonnegative()
    .parse(input.authKey.replace(/^stress-/, ""));
  const id = `tt${10000000 + index}`;
  const now = new Date().toISOString();
  const watched = state().watched;
  const item = {
    _id: id,
    type: "movie",
    _mtime: now,
    state: {
      timesWatched: watched ? 1 : 0,
      lastWatched: now,
      timeWatched: 0,
      duration: 100000,
      video_id: id,
    },
  };
  switch (url.pathname) {
    case "/api/getUser":
      return Response.json({
        result: { email: `fake-${index}@example.test`, trakt: null },
      });
    case "/api/datastoreMeta":
      return Response.json({ result: [[id, Date.parse(now)]] });
    case "/api/datastoreGet":
      return Response.json({ result: input.ids?.includes(id) ? [item] : [] });
    case "/api/addonCollectionGet":
      return Response.json({ result: { addons: [] } });
    default:
      return Response.json(
        { error: "Unknown fixture method" },
        { status: 404 },
      );
  }
}
const simklStatuses = new Map<string, Map<string, string>>();
function provider({ request, url, body }: FixtureRequest) {
  const token = bearer(request);
  if (!token?.startsWith("stress-")) return Response.json({}, { status: 401 });
  if (url.hostname === "api.simkl.com" && url.pathname === "/sync/activities")
    return Response.json({ all: null });
  if (
    url.hostname === "api.simkl.com" &&
    url.pathname.startsWith("/sync/all-items")
  ) {
    return Response.json({
      movies: [...(simklStatuses.get(token) ?? [])].map(([imdb, status]) => ({
        status,
        movie: { ids: { imdb, simkl: Number(imdb.slice(2)) } },
      })),
      shows: [],
      anime: [],
    });
  }
  const paths = [
    "/sync/history",
    "/sync/watched",
    "/sync/watchlist",
    "/sync/add-to-list",
    "/watchlist/items/add",
  ];
  if (request.method !== "POST" || !paths.includes(url.pathname))
    return Response.json({}, { status: 404 });
  const accepted = state().outage !== url.hostname;
  if (accepted && url.hostname === "api.simkl.com") {
    const items =
      z
        .object({
          movies: z
            .array(z.object({ ids: z.object({ imdb: z.string() }) }))
            .optional(),
        })
        .parse(body).movies ?? [];
    const statuses = simklStatuses.get(token) ?? new Map<string, string>();
    for (const item of items)
      statuses.set(
        item.ids.imdb,
        /watchlist|add-to-list/.test(url.pathname)
          ? "plantowatch"
          : "completed",
      );
    simklStatuses.set(token, statuses);
  }
  appendFileSync(
    receipts,
    JSON.stringify({
      at: Date.now(),
      host: url.hostname,
      token,
      kind: /watchlist|add-to-list/.test(url.pathname)
        ? "watchlist"
        : "watched",
      body,
      accepted,
    }) + "\n",
  );
  return accepted
    ? Response.json({ added: { movies: 1, episodes: 1 }, not_found: {} })
    : Response.json({ error: "Fixture outage" }, { status: 503 });
}
installFetchFixture({
  hosts: {
    "api.strem.io": stremio,
    "api.trakt.tv": provider,
    "api.simkl.com": provider,
    "api.mdblist.com": provider,
  },
});
