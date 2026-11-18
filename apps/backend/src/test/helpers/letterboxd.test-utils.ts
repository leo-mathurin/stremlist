import { http, HttpResponse } from "msw";

export const LETTERBOXD = "https://letterboxd.com";
export const BOXD_IT = "https://boxd.it";

/**
 * A Letterboxd film grid page with the films `film:<id>`, as list,
 * watchlist and collection pages render it, with an optional next page link.
 */
export function letterboxdPage(ids: number[], next?: string) {
  return `<html><head><title>Alice's list • Letterboxd</title></head><body><h1>Alice's list</h1><ul class="poster-list -grid">${ids.map((id) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="film-${id}" data-item-name="Film ${id} (2000)"></li>`).join("")}</ul>${next ? `<a class="next" href="${next}">Next</a>` : ""}</body></html>`;
}

/** A Letterboxd film page that links the film to this IMDb ID. */
export function letterboxdFilmPage(imdbId: string) {
  return `<title>Film • Letterboxd</title><a data-track-action="IMDb" href="https://www.imdb.com/title/${imdbId}/">IMDb</a>`;
}

/** One request that the fake Letterboxd site received. */
export interface LetterboxdRequest {
  url: string;
  method: string;
  redirect: RequestRedirect;
  headers: Headers;
}

/** A page body, or a function that answers the request. */
export type LetterboxdAnswer =
  | string
  | ((request: Request) => Response | Promise<Response>);

/**
 * The Letterboxd site and its boxd.it short links in memory. It serves the
 * pages that a test stores by URL, answers 404 for other URLs (or the
 * `serveAll` answer), and keeps every request it receives.
 */
export class FakeLetterboxd {
  readonly pages = new Map<string, LetterboxdAnswer>();
  readonly requests: LetterboxdRequest[] = [];
  private fallback: LetterboxdAnswer | null = null;

  /** The MSW handlers of letterboxd.com and boxd.it. */
  readonly handlers = [
    http.all(`${LETTERBOXD}/*`, ({ request }) => this.answer(request)),
    http.all(`${BOXD_IT}/*`, ({ request }) => this.answer(request)),
  ];

  reset() {
    this.pages.clear();
    this.requests.length = 0;
    this.fallback = null;
  }

  /** Serves `answer` at this full URL, for example `https://letterboxd.com/alice/watchlist/`. */
  serve(url: string, answer: LetterboxdAnswer) {
    this.pages.set(url, answer);
  }

  /** Answers every URL that has no page of its own with `answer`. */
  serveAll(answer: LetterboxdAnswer) {
    this.fallback = answer;
  }

  /** Answers this short link with a redirect to `location`. */
  redirect(url: string, location: string) {
    this.serve(
      url,
      () => new HttpResponse(null, { status: 302, headers: { location } }),
    );
  }

  /** The URLs requested, in order. */
  get urls() {
    return this.requests.map((request) => request.url);
  }

  async answer(request: Request) {
    this.requests.push({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      headers: request.headers,
    });
    const answer = this.pages.get(request.url) ?? this.fallback;
    if (answer === null) return new HttpResponse(null, { status: 404 });
    if (typeof answer === "string") return new HttpResponse(answer);
    return answer(request);
  }
}
