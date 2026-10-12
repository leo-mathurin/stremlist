import { vi } from "vitest";
import { resetSimklState } from "../../simkl";
import type { Call } from "../oauth-harness";
import {
  calls,
  connection as oauthConnection,
  json,
  stubFetch,
} from "../oauth-harness";
import { activities, ANIME, MOVIES, SHOWS } from "./fixtures";
import { r2 } from "./mocks";

export { calls, clearCalls, json, restoreStubs } from "../oauth-harness";

const LIBRARY_KEY = "connections/acc-1/simkl/library.json";

export type Route = (call: Call) => unknown;

export let routes: Record<string, Route> = {};

export function apiCalls(): string[] {
  return calls.map(({ method, url }) => {
    const from = url.searchParams.get("date_from");
    return `${method} ${url.pathname}${from ? `?date_from=${from}` : ""}`;
  });
}

export const connection = oauthConnection("simkl", "acc-1", ["simkl_at_test"]);

export function ctx() {
  return { connection };
}

interface StoredLibrary {
  checkedAt: number;
  items: { simkl: number }[];
}

export function storedLibrary(): StoredLibrary {
  return JSON.parse(r2.objects.get(LIBRARY_KEY) ?? "null") as StoredLibrary;
}

/** Pretend the last activities check is older than the gate. */
export function ageLibrary(): void {
  const library = { ...storedLibrary(), checkedAt: Date.now() - 10 * 60_000 };
  r2.objects.set(LIBRARY_KEY, JSON.stringify(library));
}

export function resetSimklTest(): void {
  vi.stubEnv("SIMKL_CLIENT_ID", "client-123");
  vi.stubEnv("SIMKL_CLIENT_SECRET", "secret-456");
  r2.objects.clear();
  r2.down = false;
  resetSimklState();
  routes = {
    "GET /sync/activities": () => activities({ all: "2026-10-01T10:00:00Z" }),
    "GET /sync/all-items/shows": () => SHOWS,
    "GET /sync/all-items/movies": () => MOVIES,
    "GET /sync/all-items/anime": () => ANIME,
  };
  stubFetch(async (call) => {
    const route = routes[`${call.method} ${call.url.pathname}`] as
      | Route
      | undefined;
    if (!route) return json({ error: "not_found" }, 404);
    const result = await route(call);
    return result instanceof Response ? result : json(result);
  });
}
