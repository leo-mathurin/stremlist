// The outbound transport of an isolated backend (see fixture-backend.ts). A
// preload declares one handler per Provider host and calls
// `installFetchFixture` once. Loopback requests (the local Supabase stack)
// use the real fetch; every other host without a handler is refused, so no
// request ever reaches a real Provider.
import { appendFileSync } from "node:fs";

/** One intercepted request: its URL and its body, read once. */
export interface FixtureRequest {
  request: Request;
  url: URL;
  /** JSON or form fields, the text when it is neither, null without a body. */
  body: unknown;
}

type FixtureHandler = (input: FixtureRequest) => Response | Promise<Response>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

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

/** The bearer token of a request, or null. */
export function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
}

/**
 * Replace `fetch` in this process. `hosts` maps a host (`api.trakt.tv`) to its
 * handler. With `log`, each request to a non-loopback host is appended to
 * that file as one JSON line: method, URL, bearer token and body.
 */
export function installFetchFixture(options: {
  hosts: Record<string, FixtureHandler>;
  log?: string;
}): void {
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
      const text = request.method === "GET" ? "" : await request.text();
      const body = parseBody(text, request.headers.get("content-type"));
      if (options.log) {
        appendFileSync(
          options.log,
          `${JSON.stringify({
            method: request.method,
            url: request.url,
            authorization: bearer(request),
            body,
          })}\n`,
        );
      }
      const handler = options.hosts[url.host];
      if (!handler) {
        throw new Error(
          `Fetch fixture refuses outbound request to ${url.host}`,
        );
      }
      return handler({ request, url, body });
    },
  });
}

/** The operation name and variables of a GraphQL request body. */
export function graphql<Variables = Record<string, unknown>>(
  body: unknown,
): { operation: string; query: string; variables: Variables } {
  const {
    query = "",
    operationName,
    variables,
  } = (body ?? {}) as {
    query?: string;
    operationName?: string;
    variables?: Variables;
  };
  return {
    operation: operationName ?? /query (\w+)/.exec(query)?.[1] ?? "",
    query,
    variables: variables ?? ({} as Variables),
  };
}
