/**
 * The fetch mock and R2 state that every Simkl adapter test file shares.
 */
import { vi } from "vitest";
import { resetSimklState } from "../../simkl";
import type { ConnectionAccess } from "../../types";
import { activities, ANIME, MOVIES, SHOWS } from "./fixtures";
import { r2 } from "./mocks";

export const LIBRARY_KEY = "connections/acc-1/simkl/library.json";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

export type Route = (call: Call) => unknown;

export let calls: Call[] = [];
export let routes: Record<string, Route> = {};

/** Forget the calls so far, to check only the ones that follow. */
export function clearCalls(): void {
  calls = [];
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function apiCalls(): string[] {
  return calls.map(
    (call) =>
      `${call.method} ${call.url.pathname}${
        call.url.searchParams.get("date_from")
          ? `?date_from=${call.url.searchParams.get("date_from")}`
          : ""
      }`,
  );
}

export function defaultRoutes(current: unknown): Record<string, Route> {
  return {
    "GET /sync/activities": () => current,
    "GET /sync/all-items/shows": () => SHOWS,
    "GET /sync/all-items/movies": () => MOVIES,
    "GET /sync/all-items/anime": () => ANIME,
  };
}

export const connection: ConnectionAccess = {
  accountId: "acc-1",
  provider: "simkl",
  username: "leo",
  getAccessToken: () => Promise.resolve("simkl_at_test"),
  reportRefused: () => Promise.resolve(),
  reportWorking: () => Promise.resolve(),
};

export function ctx() {
  return { connection };
}

export function storedLibrary(): {
  checkedAt: number;
  items: { simkl: number }[];
} {
  return JSON.parse(r2.objects.get(LIBRARY_KEY) ?? "null") as {
    checkedAt: number;
    items: { simkl: number }[];
  };
}

/** Pretend the last activities check is older than the gate. */
export function ageLibrary(): void {
  const library = storedLibrary();
  r2.objects.set(
    LIBRARY_KEY,
    JSON.stringify({ ...library, checkedAt: Date.now() - 10 * 60_000 }),
  );
}

export function resetSimklTest(): void {
  process.env.SIMKL_CLIENT_ID = "client-123";
  process.env.SIMKL_CLIENT_SECRET = "secret-456";
  r2.objects.clear();
  r2.down = false;
  resetSimklState();
  calls = [];
  routes = defaultRoutes(activities({ all: "2026-10-01T10:00:00Z" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`] as Route | undefined;
    if (!route) return json({ error: "not_found" }, 404);
    const result = await route(call);
    return result instanceof Response ? result : json(result);
  });
}

export function restoreSimklTest(): void {
  vi.restoreAllMocks();
}
