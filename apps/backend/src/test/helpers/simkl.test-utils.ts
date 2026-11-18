import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import { vi } from "vite-plus/test";

export const SIMKL_TRENDING = "https://data.simkl.in/discover/trending";
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

/** One request that the fake Simkl received. */
export interface SimklRequest {
  method: string;
  url: URL;
  token: string | null;
  body: unknown;
}

/**
 * Simkl in memory: the trending files of its CDN, and the API answers that a
 * test stores by path. Other paths answer 404. It keeps every request it
 * receives.
 */
export class FakeSimkl {
  /** The Titles by file path, for example `movies/week_100.json`. */
  readonly trending = new Map<string, StremioMeta[]>();
  /** The API answers by path, for example `/sync/add-to-list`. */
  readonly api = new Map<string, { status: number; body?: unknown }>();
  readonly requests: SimklRequest[] = [];

  /** The MSW handlers of the trending CDN and the API. */
  readonly handlers = [
    http.get(`${SIMKL_TRENDING}/*`, ({ request }) => this.answer(request)),
    http.all(`${SIMKL_API}/*`, ({ request }) => this.answerApi(request)),
  ];

  /** The MSW handler of the trending CDN only. */
  get handler() {
    return this.handlers[0];
  }

  reset() {
    this.trending.clear();
    this.api.clear();
    this.requests.length = 0;
  }

  /** Answers the API `path` with this status, and optionally this JSON body. */
  reply(path: string, status: number, body?: unknown) {
    this.api.set(path, { status, body });
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
    const answer = this.api.get(url.pathname);
    if (!answer) return new HttpResponse(null, { status: 404 });
    return answer.body === undefined
      ? new HttpResponse(null, { status: answer.status })
      : HttpResponse.json(answer.body, { status: answer.status });
  }

  /** The requests of one trending file. */
  requestsOf(path: string) {
    return this.requests.filter(
      (request) => request.url.pathname === `/discover/trending/${path}`,
    );
  }

  answer(request: Request) {
    const url = this.record(request, null);
    const path = url.pathname.replace(/^\/discover\/trending\//, "");
    const metas = this.trending.get(path);
    if (!metas) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(metas.map(simklTrendingItem));
  }
}
