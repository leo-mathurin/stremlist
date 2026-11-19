import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import { vi } from "vite-plus/test";
import { unexpectedRequest } from "./msw.test-utils";

export const SIMKL_CDN = "https://data.simkl.in/discover";
export const SIMKL_API = "https://api.simkl.com";

/** Configures a Simkl app, so that the Simkl adapter sends its requests. */
export function useSimklApp() {
  vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
  vi.stubEnv("SIMKL_CLIENT_SECRET", "");
}

/**
 * A row of a Simkl trending file for this Title. Its Simkl ID is the number
 * of its IMDb ID, and its slug is `title-<number>`.
 */
export function simklTrendingItem(meta: StremioMeta) {
  const simkl = Number(meta.id.replace(/^tt/, ""));
  return {
    title: meta.name,
    release_date: meta.releaseInfo ? `01/01/${meta.releaseInfo}` : null,
    ids: { simkl, slug: `title-${simkl}`, imdb: meta.id },
  };
}

/** The Simkl page that the adapter links a trending Title to. */
export function simklPageOf(meta: StremioMeta, kind = "movies") {
  const simkl = Number(meta.id.replace(/^tt/, ""));
  return `https://simkl.com/${kind}/${simkl}/title-${simkl}`;
}

function cdnPath(url: URL) {
  const path = url.pathname.replace(/^\/discover\//, "");
  return path.startsWith("trending/") ? path.slice("trending/".length) : path;
}

/** One request that the fake Simkl received. */
export interface SimklRequest {
  method: string;
  url: URL;
  token: string | null;
  body: unknown;
}

/**
 * Simkl in memory: the chart files of its CDN, and the API answers that a
 * test stores by method and path. It keeps every request it receives. An API
 * path answers GET only, unless the test gives the method of a write, for
 * example `reply("/sync/add-to-list", 201, body, "POST")`. A request with
 * another method or for another file or path is an `unexpectedRequest` that
 * fails the test: a test that wants an error answer sets it with `reply` or
 * `failTrending`.
 */
export class FakeSimkl {
  /** The Titles by file path, for example `movies/week_100.json` or `dvd/releases_100.json`. */
  readonly trending = new Map<string, StremioMeta[]>();
  /** The API answers by `${method} ${path}`, for example `POST /sync/add-to-list`. */
  readonly api = new Map<string, { status: number; body?: unknown }>();
  /** The error statuses of trending files by path, for example `movies/week_100.json`. */
  readonly trendingFailures = new Map<string, number>();
  readonly requests: SimklRequest[] = [];

  /** The MSW handlers of the chart CDN and the API. */
  readonly handlers = [
    http.get(`${SIMKL_CDN}/*`, ({ request }) => this.answer(request)),
    http.all(`${SIMKL_API}/*`, ({ request }) => this.answerApi(request)),
  ];

  /** The MSW handler of the chart CDN only. */
  get handler() {
    return this.handlers[0];
  }

  reset() {
    this.trending.clear();
    this.api.clear();
    this.trendingFailures.clear();
    this.requests.length = 0;
  }

  /** Answers `method` requests to the API `path` with this status, and optionally this JSON body. */
  reply(path: string, status: number, body?: unknown, method = "GET") {
    this.api.set(`${method} ${path}`, { status, body });
  }

  /** Answers the CDN file `path`, when it has no Titles, with this status and no body. */
  failTrending(path: string, status: number) {
    this.trendingFailures.set(path, status);
  }

  /** The API requests to `path`. */
  apiRequestsOf(path: string) {
    return this.requests.filter(
      (request) =>
        request.url.origin === SIMKL_API && request.url.pathname === path,
    );
  }

  private record(request: Request, body: unknown) {
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      url,
      token:
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null,
      body,
    });
    return url;
  }

  async answerApi(request: Request) {
    const raw = request.method === "GET" ? "" : await request.text();
    const body: unknown = raw ? JSON.parse(raw) : null;
    const url = this.record(request, body);
    const answer = this.api.get(`${request.method} ${url.pathname}`);
    if (!answer) {
      return unexpectedRequest(
        request,
        `FakeSimkl serves no ${request.method} API answer here`,
      );
    }
    return answer.body === undefined
      ? new HttpResponse(null, { status: answer.status })
      : HttpResponse.json(answer.body, { status: answer.status });
  }

  /** The requests of one CDN file. */
  requestsOf(path: string) {
    return this.requests.filter(
      (request) =>
        request.url.origin !== SIMKL_API && cdnPath(request.url) === path,
    );
  }

  answer(request: Request) {
    const url = this.record(request, null);
    const path = cdnPath(url);
    const metas = this.trending.get(path);
    if (metas) return HttpResponse.json(metas.map(simklTrendingItem));
    const failure = this.trendingFailures.get(path);
    if (failure !== undefined)
      return new HttpResponse(null, { status: failure });
    return unexpectedRequest(request, "FakeSimkl serves no CDN file here");
  }
}
