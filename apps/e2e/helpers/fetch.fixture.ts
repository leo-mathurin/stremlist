import { appendFileSync } from "node:fs";
import { http, HttpResponse, passthrough } from "msw";
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

function refuse(request: Request, reason: string) {
  const entry = `${JSON.stringify({ method: request.method, url: request.url, reason })}\n`;
  const file = process.env.E2E_UNEXPECTED_REQUEST_LOG;
  if (file) appendFileSync(file, entry);
  else console.error(`Unexpected fixture request: ${entry}`);
  return HttpResponse.error();
}

/**
 * Refuse a request that the fixture does not support. The host handler
 * records it as an unexpected request and answers it with a network error.
 */
export function unsupported(request: Request, reason: string): never {
  throw new Error(
    `${reason}: ${request.method} ${new URL(request.url).pathname}`,
  );
}

function hostPattern(host: string) {
  return new RegExp(`^https?://${host.replaceAll(".", String.raw`\.`)}(?:/|$)`);
}

/**
 * Answer the outbound requests of this process with MSW. `hosts` maps a host
 * (`api.trakt.tv`) to its handler. `passthrough` hosts reach the real service
 * (a test that runs with a real key). Loopback requests always pass through,
 * and a request to any other host fails: a final catch-all handler answers
 * it with a network error and appends its method and URL to the
 * `E2E_UNEXPECTED_REQUEST_LOG` file, so the suite can fail on it. A host
 * handler that throws (see `unsupported`) gets the same treatment, with the
 * error message as the reason, so a request that no fixture supports never
 * looks like a Provider failure that a test expects. MSW's own "error"
 * strategy lets some file types (.json, .html) through, so it alone cannot
 * keep a fixture off the real network. With `log`, each request to a
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
        try {
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
          return await handler({ request, url, body });
        } catch (error) {
          return refuse(
            request,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    ),
    http.all("*", ({ request }) =>
      refuse(request, "No fixture answers this host"),
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
