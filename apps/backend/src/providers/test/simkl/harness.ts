import type { SetupServer } from "msw/node";
import { vi } from "vite-plus/test";
import { z } from "zod";
import {
  r2Objects,
  r2Unreadable,
  resetR2,
} from "../../../test/helpers/r2.test-utils";
import { resetSimklState } from "../../simkl";
import { SIMKL_API } from "../../simkl/api";
import type { Call } from "../oauth-harness";
import {
  calls,
  connection as oauthConnection,
  json,
  serveApi,
  useFreshLimiters,
} from "../oauth-harness";
import { activities, ANIME, MOVIES, SHOWS } from "./simkl.fixture";

export { calls, clearCalls, json, restoreStubs } from "../oauth-harness";

const LIBRARY_KEY = "connections/acc-1/simkl/library.json";

export type Route = (call: Call) => unknown;

export const routes = new Map<string, Route>();

export function apiCalls() {
  return calls.map(({ method, url }) => {
    const from = url.searchParams.get("date_from");
    return `${method} ${url.pathname}${from ? `?date_from=${from}` : ""}`;
  });
}

export const connection = oauthConnection("simkl", "acc-1", "simkl_at_test");

export function ctx() {
  return { connection };
}

const storedLibrarySchema = z
  .object({
    checkedAt: z.number(),
    items: z.array(z.object({ simkl: z.number() }).loose()),
  })
  .loose();

export function storedLibrary() {
  return storedLibrarySchema.parse(
    JSON.parse(r2Objects.get(LIBRARY_KEY) ?? "null"),
  );
}

/** Pretend the last activities check is older than the gate. */
export function ageLibrary() {
  const library = { ...storedLibrary(), checkedAt: Date.now() - 10 * 60_000 };
  r2Objects.set(LIBRARY_KEY, JSON.stringify(library));
}

/** Stores this library snapshot, as an earlier read would have. */
export function storeLibrary(library: unknown) {
  r2Objects.set(LIBRARY_KEY, JSON.stringify(library));
}

/** R2 unreachable: reads of the library fail with an error other than NoSuchKey. */
export function breakR2() {
  r2Unreadable.add(LIBRARY_KEY);
}

export function resetSimklTest(server: SetupServer) {
  useFreshLimiters();
  vi.stubEnv("SIMKL_CLIENT_ID", "client-123");
  vi.stubEnv("SIMKL_CLIENT_SECRET", "secret-456");
  resetR2();
  resetSimklState();
  routes.clear();
  routes.set("GET /sync/activities", () =>
    activities({ all: "2026-10-01T10:00:00Z" }),
  );
  routes.set("GET /sync/all-items/shows", () => SHOWS);
  routes.set("GET /sync/all-items/movies", () => MOVIES);
  routes.set("GET /sync/all-items/anime", () => ANIME);
  serveApi(server, [SIMKL_API, "https://data.simkl.in"], async (call) => {
    const route = routes.get(`${call.method} ${call.url.pathname}`);
    if (!route) return json({ error: "not_found" }, 404);
    const result = await route(call);
    return result instanceof Response ? result : json(result);
  });
}
