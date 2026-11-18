import { appendFileSync } from "node:fs";
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
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The bearer token of a request, or null. */
export function bearer(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
}

/**
 * Replace `fetch` in this process. `hosts` maps a host (`api.trakt.tv`) to its
 * handler. `passthrough` hosts reach the real service (a test that runs with
 * a real key). With `log`, each request to a non-loopback host is appended to
 * that file as one JSON line: method, URL, bearer token and body; requests
 * that pass through log only their method and URL, never their credentials.
 */
export function installFetchFixture(options: {
  hosts: Record<string, FixtureHandler>;
  passthrough?: string[];
  log?: string;
}) {
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
      if (options.passthrough?.includes(url.host)) {
        if (options.log) {
          appendFileSync(
            options.log,
            `${JSON.stringify({
              method: request.method,
              url: request.url,
              authorization: null,
              body: null,
            })}\n`,
          );
        }
        return realFetch(input, init);
      }
      const text = request.method === "GET" ? "" : await request.text();
      const body = text
        ? parseBody(text, request.headers.get("content-type"))
        : null;
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
