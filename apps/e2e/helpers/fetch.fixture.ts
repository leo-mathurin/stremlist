import { appendFileSync } from "node:fs";
import { http, passthrough } from "msw";
import { setupServer } from "msw/node";
import { type Guard, isRecord, isString, parsed } from "./json.js";

/** One intercepted request: its URL and its body, read once. */
export interface FixtureRequest {
  request: Request;
  url: URL;
  /** JSON or form fields, the text when it is neither, null without a body. */
  body: unknown;
}

type FixtureHandler = (input: FixtureRequest) => Response | Promise<Response>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseBody(text: string, contentType: string | null) {
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const json: unknown = JSON.parse(text);
    return json;
  } catch {
    return text;
  }
}

/** The bearer token of a request, or null. */
export function bearer(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
}

function logRequest(
  file: string | undefined,
  entry: { request: Request; authorization: string | null; body: unknown },
) {
  if (!file) return;
  appendFileSync(
    file,
    `${JSON.stringify({
      method: entry.request.method,
      url: entry.request.url,
      authorization: entry.authorization,
      body: entry.body,
    })}\n`,
  );
}

function hostPattern(host: string) {
  return new RegExp(`^https?://${host.replaceAll(".", String.raw`\.`)}(?:/|$)`);
}

/**
 * Answer the outbound requests of this process with MSW. `hosts` maps a host
 * (`api.trakt.tv`) to its handler. `passthrough` hosts reach the real service
 * (a test that runs with a real key). Loopback requests always pass through,
 * and a request to any other host fails. With `log`, each request to a
 * non-loopback host is appended to that file as one JSON line: method, URL,
 * bearer token and body; requests that pass through log only their method and
 * URL, never their credentials.
 */
export function installFetchFixture(options: {
  hosts: Record<string, FixtureHandler>;
  passthrough?: string[];
  log?: string;
}) {
  const server = setupServer(
    http.all(
      ({ request }) => LOOPBACK.has(new URL(request.url).hostname),
      () => passthrough(),
    ),
    ...(options.passthrough ?? []).map((host) =>
      http.all(hostPattern(host), ({ request }) => {
        logRequest(options.log, { request, authorization: null, body: null });
        return passthrough();
      }),
    ),
    ...Object.entries(options.hosts).map(([host, handler]) =>
      http.all(hostPattern(host), async ({ request }) => {
        const url = new URL(request.url);
        const text = request.method === "GET" ? "" : await request.text();
        const body = text
          ? parseBody(text, request.headers.get("content-type"))
          : null;
        logRequest(options.log, {
          request,
          authorization: bearer(request),
          body,
        });
        return handler({ request, url, body });
      }),
    ),
  );
  server.listen({ onUnhandledRequest: "error" });
  return server;
}

/**
 * The operation name and variables of a GraphQL request body. `is` checks
 * the variables; absent variables are `{}`.
 */
export function graphql<Variables>(body: unknown, is: Guard<Variables>) {
  const field = (key: string) => (isRecord(body) ? body[key] : undefined);
  const query = field("query");
  const operationName = field("operationName");
  const text = isString(query) ? query : "";
  return {
    operation: isString(operationName)
      ? operationName
      : (/query (\w+)/.exec(text)?.[1] ?? ""),
    query: text,
    variables: parsed(field("variables") ?? {}, is, "GraphQL variables"),
  };
}
