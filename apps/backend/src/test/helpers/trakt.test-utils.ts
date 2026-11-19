import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import { vi } from "vite-plus/test";
import { unexpectedRequest } from "./msw.test-utils";

export const TRAKT_API = "https://api.trakt.tv";

/** Trakt list items for these Titles, as the Trakt list endpoints send them. */
export function traktItems(metas: StremioMeta[]) {
  return metas.map((meta) => {
    const media = { title: meta.name, ids: { imdb: meta.id } };
    return meta.type === "series"
      ? { type: "show", show: media }
      : { type: "movie", movie: media };
  });
}

/** Configures a Trakt app, so that the Trakt adapter sends its requests. */
export function useTraktApp() {
  vi.stubEnv("TRAKT_CLIENT_ID", "trakt-app");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "");
}

/** One request that the fake Trakt API received. */
export interface TraktRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: unknown;
}

type TraktAnswer = unknown[] | { status: number; body?: unknown };

/**
 * A Trakt API in memory. It serves the items that a test stores for a path,
 * page by page as Trakt does, and keeps every request it receives. A request
 * for another path is an `unexpectedRequest` that fails the test: a test
 * that wants an error answer sets it with `fail` or `failOthers`.
 */
export class FakeTrakt {
  readonly paths = new Map<string, TraktAnswer>();
  readonly requests: TraktRequest[] = [];
  private othersStatus: number | null = null;

  /** The MSW handler of every Trakt API call. */
  readonly handler = http.all(`${TRAKT_API}/*`, ({ request }) =>
    this.answer(request),
  );

  reset() {
    this.paths.clear();
    this.requests.length = 0;
    this.othersStatus = null;
  }

  /** Serves these Titles as the items of `path`, for example `/users/leo/watchlist`. */
  serve(path: string, metas: StremioMeta[]) {
    this.paths.set(path, traktItems(metas));
  }

  /**
   * Serves these raw Trakt items as `path`, for items that `serve` cannot
   * make: no IMDb ID, dates, ratings.
   */
  serveItems(path: string, items: unknown[]) {
    this.paths.set(path, structuredClone(items));
  }

  /** Answers `path` with this JSON body (not paged), for example a sync result. */
  reply(path: string, body: unknown, status = 200) {
    this.paths.set(path, { status, body });
  }

  /** Answers `path` with this status, and optionally this JSON body. */
  fail(path: string, status: number, body?: unknown) {
    this.paths.set(path, { status, body });
  }

  /**
   * Answers every path that has no answer of its own with this status, for a
   * test that reads every Trakt list on purpose.
   */
  failOthers(status: number) {
    this.othersStatus = status;
  }

  /** The requests to `path`. */
  requestsOf(path: string) {
    return this.requests.filter((request) => request.path === path);
  }

  async answer(request: Request) {
    const url = new URL(request.url);
    const raw = request.method === "GET" ? "" : await request.text();
    const body: unknown = raw ? JSON.parse(raw) : null;
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      token,
      body,
    });
    const answer = this.paths.get(url.pathname);
    if (answer === undefined) {
      return this.othersStatus === null
        ? unexpectedRequest(request, "FakeTrakt serves no answer here")
        : new HttpResponse(null, { status: this.othersStatus });
    }
    if (!Array.isArray(answer)) {
      return answer.body === undefined
        ? new HttpResponse(null, { status: answer.status })
        : HttpResponse.json(answer.body, { status: answer.status });
    }
    const limit = Number(url.searchParams.get("limit") ?? answer.length);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageCount = Math.max(1, Math.ceil(answer.length / limit));
    return HttpResponse.json(answer.slice((page - 1) * limit, page * limit), {
      headers: {
        "X-Pagination-Page": String(page),
        "X-Pagination-Page-Count": String(pageCount),
        "X-Pagination-Item-Count": String(answer.length),
      },
    });
  }
}
