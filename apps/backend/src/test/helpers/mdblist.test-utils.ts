import { http, HttpResponse } from "msw";
import { vi } from "vite-plus/test";
import { unexpectedRequest } from "./msw.test-utils";

export const MDBLIST_API = "https://api.mdblist.com";

/** Configures an MDBList app, so that the MDBList adapter sends its requests. */
export function useMdblistApp() {
  vi.stubEnv("MDBLIST_CLIENT_ID", "mdblist-app");
  vi.stubEnv("MDBLIST_CLIENT_SECRET", "");
}

/** One request that the fake MDBList API received. */
export interface MdblistRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: unknown;
}

/**
 * The MDBList API in memory. It answers each path with the JSON that a test
 * stores and keeps every request it receives. A request for another path is
 * an `unexpectedRequest` that fails the test: a test that wants an error
 * answer sets it with `fail`.
 */
export class FakeMdblist {
  readonly paths = new Map<string, { status: number; body?: unknown }>();
  readonly requests: MdblistRequest[] = [];

  /** The MSW handler of every MDBList API call. */
  readonly handler = http.all(`${MDBLIST_API}/*`, ({ request }) =>
    this.answer(request),
  );

  reset() {
    this.paths.clear();
    this.requests.length = 0;
  }

  /** Answers `path` with this JSON body and status. */
  reply(path: string, body: unknown, status = 200) {
    this.paths.set(path, { status, body });
  }

  /** Answers `path` with this status and no body. */
  fail(path: string, status: number) {
    this.paths.set(path, { status });
  }

  /** The requests to `path`. */
  requestsOf(path: string) {
    return this.requests.filter((request) => request.path === path);
  }

  async answer(request: Request) {
    const url = new URL(request.url);
    const raw = request.method === "GET" ? "" : await request.text();
    const body: unknown = raw ? JSON.parse(raw) : null;
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      token:
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null,
      body,
    });
    const answer = this.paths.get(url.pathname);
    if (!answer) {
      return unexpectedRequest(request, "FakeMdblist serves no answer here");
    }
    return answer.body === undefined
      ? new HttpResponse(null, { status: answer.status })
      : HttpResponse.json(answer.body, { status: answer.status });
  }
}
