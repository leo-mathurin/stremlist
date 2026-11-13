import { parseSourceLink } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { load } from "cheerio";
import { createHash } from "node:crypto";
import { decryptSecret, encryptStable } from "../lib/crypto";
import { wikidataStrategy } from "../titles/wikidata";
import { providerFetch } from "./http";
import { isProviderEnabled } from "./kill-switch";
import {
  LETTERBOXD_FRESHNESS_MS,
  letterboxdSnapshot,
} from "./letterboxd-cache";
import {
  assertLetterboxdNotHalted,
  LetterboxdBusyError,
  letterboxdRateLimited,
  withLetterboxdPermit,
} from "./letterboxd-gate";
import type { PermitOptions } from "./letterboxd-gate";
import { parseLetterboxdPage } from "./letterboxd-page";
import type { LetterboxdFilm } from "./letterboxd-page";
import {
  excerpt,
  noteExcerpt,
  noteResponse,
  requestDetails,
} from "./letterboxd-request-log";
import { currentReadQueue } from "./read-priority";
import type {
  ProviderAdapter,
  ProviderContext,
  ResolverStrategy,
  SourceSnapshot,
} from "./types";
import { SourceUnavailableError } from "./types";

const SOURCE =
  /^users\/([a-z0-9_]{1,40})\/(watchlist|lists\/([a-z0-9]+(?:[-_][a-z0-9]+)*))$/;
// Public member collections: watched films, rating-filtered films, diary, likes.
const COLLECTION =
  /^users\/([a-z0-9_]{1,40})\/(films(?:\/rated\/\d(?:\.\d)?(?:-\d(?:\.\d)?)?)?|diary|likes\/films)$/;
const MAX_PAGES = 100;
/** About how long one more page of a read takes, for the queue estimate. */
const PAGE_ESTIMATE_MS = 400;
type PageRead =
  | { ok: true; html: string }
  | {
      ok: false;
      reason: SourceProblemReason;
      /** HTTP 429: the Retry-After, in ms (0 when absent). */
      rateLimitedMs?: number;
      /** A redirect: where Letterboxd sends the read instead. */
      movedTo?: string;
    };

const SHARE_PREFIX = "share/";
const PROVISIONAL_SHARE_PREFIX = "lbxshare/";
const SHORT_PREFIX = "lbxshort/";

/**
 * Letterboxd moved a Source list to a new address (HTTP 301): its member or
 * the list was renamed. `ref` is the parsed reference of the new address,
 * not yet resolved. Where nothing follows it, it is a temporary failure.
 */
class LetterboxdMovedError extends SourceUnavailableError {
  constructor(readonly ref: string) {
    super("unavailable", "Letterboxd moved this list");
    this.name = "LetterboxdMovedError";
  }
}

/**
 * The Source list behind a redirect from the first page of a Source list, or
 * null when it is not the same kind of Source list at another address. Pages
 * after the first, film pages and boxd.it links are never followed.
 */
function movedRef(from: string, location: string): string | null {
  let href: string;
  try {
    href = new URL(location, from).href;
  } catch {
    return null;
  }
  const before = parseSourceLink(from);
  const after = parseSourceLink(href);
  if (
    before?.provider !== "letterboxd" ||
    after?.provider !== "letterboxd" ||
    after.kind !== before.kind ||
    after.sourceRef === before.sourceRef ||
    after.sourceRef.startsWith(SHORT_PREFIX)
  )
    return null;
  return after.sourceRef;
}

/**
 * Letterboxd writes a rating range without trailing zeros (4.0-5.0 is 4-5) in
 * its pagination links, so the page path must use the same form.
 */
function canonicalRating(path: string) {
  return path.replace(/(?<=\/rated\/)[\d.-]+$/, (range) =>
    range
      .split("-")
      .map((value) => String(Number(value)))
      .join("-"),
  );
}

/** The letterboxd.com path for a stored Source list reference. */
function sourcePath(ref: string) {
  // A stored Share link: the token is encrypted; decrypt it to the real path.
  // Provisional references (lbxshare/, lbxshort/) are never read directly: they
  // are resolved and encrypted in validateSource before storage, so a plaintext
  // token can never reach a Catalog read.
  if (ref.startsWith(SHARE_PREFIX)) {
    return `/${decryptSecret(ref.slice(SHARE_PREFIX.length))}/`;
  }
  const collection = COLLECTION.exec(ref);
  if (collection) return `/${collection[1]}/${canonicalRating(collection[2])}/`;
  const match = SOURCE.exec(ref);
  if (!match)
    throw new SourceUnavailableError(
      "not_found",
      "Use a full public Letterboxd list or watchlist URL",
    );
  return `/${match[1]}/${match[3] ? `list/${match[3]}/` : "watchlist/"}`;
}

/** A diary reference carries per-entry watch dates. */
function isDiaryPath(base: string) {
  return base.endsWith("/diary/");
}

/**
 * The catalog title to suggest. A watchlist and a list (or shared list) are
 * named by the page itself; a member's films, diary or likes are better named
 * by the pasted-link suggestion, so leave those to the caller.
 */
function suggestTitle(ref: string, pageTitle: string): string | undefined {
  if (ref.endsWith("/watchlist")) return `${SOURCE.exec(ref)?.[1]}'s watchlist`;
  if (ref.startsWith(SHARE_PREFIX) || ref.includes("/lists/")) return pageTitle;
  return undefined;
}

/** Follow a boxd.it short link once and return the parsed Source reference. */
async function resolveShortLink(code: string): Promise<string> {
  if (!isProviderEnabled("letterboxd"))
    throw new SourceUnavailableError("disabled", "Letterboxd is turned off");
  const read = await withLetterboxdPermit<
    | { ok: true; url: string }
    | { ok: false; reason: SourceProblemReason; rateLimitedMs?: number }
  >(
    async () => {
      const details = requestDetails("short_link", `https://boxd.it/${code}`);
      try {
        const response = await providerFetch(details.url, {
          redirect: "manual",
          timeoutMs: 10_000,
          retryOn429: false,
          headers: { Accept: "text/html" },
        });
        noteResponse(details, response);
        const blocked =
          response.status === 403 ||
          response.headers.get("cf-mitigated") === "challenge";
        if (blocked || response.status === 429 || response.status >= 500)
          noteExcerpt(details, response);
        else await response.body?.cancel();
        if (blocked || response.status === 429)
          return {
            value: {
              ok: false,
              reason: "unavailable",
              ...(blocked ? {} : { rateLimitedMs: retryAfterOf(response) }),
            },
            result: blocked ? "blocked" : "rate_limited",
            retryAfterMs: retryAfterOf(response),
            details,
          };
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location)
          return { value: { ok: true, url: location }, result: "ok", details };
        return {
          value: {
            ok: false,
            reason: response.status === 404 ? "not_found" : "unavailable",
          },
          result: response.status >= 500 ? "failed" : "ok",
          details,
        };
      } catch (error) {
        details.error = errorText(error);
        return {
          value: { ok: false, reason: "unavailable" },
          result: "failed",
          details,
        };
      }
    },
    { first: true },
  );
  if (!read.ok) {
    if (read.rateLimitedMs !== undefined)
      throw letterboxdRateLimited(read.rateLimitedMs);
    throw new SourceUnavailableError(
      read.reason,
      "Letterboxd could not resolve this short link",
    );
  }
  const parsed = parseSourceLink(read.url);
  if (parsed?.provider !== "letterboxd")
    throw new SourceUnavailableError(
      "not_found",
      "This boxd.it link is not a list or watchlist",
    );
  return parsed.sourceRef;
}

/**
 * Normalize a reference into the one that gets stored and read: resolve a
 * boxd.it short link, and encrypt a Share link token so it never rests in
 * plaintext. Public references pass through.
 */
async function resolveRef(ref: string): Promise<string> {
  if (ref.startsWith(SHORT_PREFIX)) {
    return resolveRef(await resolveShortLink(ref.slice(SHORT_PREFIX.length)));
  }
  if (ref.startsWith(PROVISIONAL_SHARE_PREFIX)) {
    // Stable encryption: the same share link always yields the same stored
    // reference, so adding it twice is caught as a duplicate.
    return `${SHARE_PREFIX}${encryptStable(ref.slice(PROVISIONAL_SHARE_PREFIX.length))}`;
  }
  return ref;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** Retry-After in milliseconds, from seconds or an HTTP date; 0 when absent. */
function retryAfterOf(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter))
    return Math.min(Number(retryAfter) * 1000, 24 * 60 * 60_000);
  return Math.max(0, Date.parse(retryAfter ?? "") - Date.now()) || 0;
}

async function readHtml(
  url: string,
  kind: "collection" | "film" = "collection",
  nextPageUrl?: string,
  page: { diary?: boolean } = {},
  permit: PermitOptions = {},
) {
  if (!isProviderEnabled("letterboxd"))
    throw new SourceUnavailableError("disabled", "Letterboxd is turned off");
  const read = await withLetterboxdPermit<PageRead>(async () => {
    let blocked = false;
    let retryAfterMs = 0;
    const details = requestDetails(kind, url);
    try {
      const response = await providerFetch(url, {
        redirect: "manual",
        timeoutMs: 10_000,
        retryOn429: false,
        headers: { Accept: "text/html" },
      });
      noteResponse(details, response);
      blocked =
        response.status === 403 ||
        response.headers.get("cf-mitigated") === "challenge";
      retryAfterMs = retryAfterOf(response);
      if (blocked || (response.status !== 200 && response.status < 500)) {
        if (blocked || response.status === 429) noteExcerpt(details, response);
        else await response.body?.cancel();
        const location = response.headers.get("location");
        const moved =
          kind === "collection" &&
          response.status >= 300 &&
          response.status < 400 &&
          location
            ? movedRef(url, location)
            : null;
        return {
          value: {
            ok: false,
            reason: response.status === 404 ? "not_found" : "unavailable",
            ...(!blocked && response.status === 429
              ? { rateLimitedMs: retryAfterMs }
              : {}),
            ...(moved ? { movedTo: moved } : {}),
          },
          result: blocked
            ? "blocked"
            : response.status === 429
              ? "rate_limited"
              : "ok",
          retryAfterMs,
          details,
        };
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("EmptyLetterboxdResponse");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1_000_000) throw new Error("LetterboxdResponseTooLarge");
          chunks.push(part.value);
        }
      } finally {
        // Kept even when the read stops early: the first bytes explain why.
        details.bytes = bytes;
        details.bodyExcerpt = excerpt(Buffer.concat(chunks).toString("utf8"));
        await reader.cancel();
      }
      const html = Buffer.concat(chunks).toString("utf8");
      const parsed = parseLetterboxdPage(html, page);
      blocked = parsed.blocked;
      const paginationValid =
        !parsed.next || new URL(parsed.next, url).href === nextPageUrl;
      if (
        !blocked &&
        (response.status !== 200 ||
          (kind === "collection" && (!parsed.valid || !paginationValid)))
      ) {
        return {
          value: { ok: false, reason: "unavailable" },
          result: "failed",
          retryAfterMs,
          details,
        };
      }
      return {
        value: blocked
          ? { ok: false, reason: "unavailable" }
          : { ok: true, html },
        result: blocked ? "blocked" : "ok",
        details,
      };
    } catch (error) {
      details.error = errorText(error);
      // A body timeout after HTTP 200 is still a failed read, never valid empty content.
      return {
        value: { ok: false, reason: "unavailable" },
        result: blocked ? "blocked" : "failed",
        retryAfterMs,
        details,
      };
    }
  }, permit);
  if (!read.ok) {
    if (read.rateLimitedMs !== undefined)
      throw letterboxdRateLimited(read.rateLimitedMs);
    if (read.movedTo) throw new LetterboxdMovedError(read.movedTo);
    throw new SourceUnavailableError(
      read.reason,
      "Letterboxd could not read this public list",
    );
  }
  return read.html;
}

function pagePath(base: string, page: number) {
  return page === 1 ? base : `${base}page/${page}/`;
}

/**
 * One page of a Source list, from the shared cache or Letterboxd. `restMs`
 * estimates the rest of the read after this page.
 */
async function readPage(
  base: string,
  page: number,
  forceRefresh = false,
  restMs = 0,
) {
  const path = pagePath(base, page);
  const key = `providers/letterboxd/pages-v1/${createHash("sha256").update(path).digest("hex")}.json`;
  const options = { diary: isDiaryPath(base) };
  const url = `https://letterboxd.com${path}`;
  return letterboxdSnapshot(
    key,
    async () => {
      const parsed = parseLetterboxdPage(
        await readHtml(
          url,
          "collection",
          `https://letterboxd.com${pagePath(base, page + 1)}`,
          options,
          { first: page === 1, restMs },
        ),
        options,
      );
      return {
        films: parsed.films,
        complete: parsed.next === null,
        title: parsed.title,
        ...(parsed.pages ? { pages: parsed.pages } : {}),
      };
    },
    forceRefresh,
  );
}

/**
 * The first page of a Source list. When its member or the list was renamed
 * (HTTP 301), it follows the new address once and returns its reference.
 */
async function readFirstPage(ref: string, forceRefresh = false) {
  try {
    return { ref, page: await readPage(sourcePath(ref), 1, forceRefresh) };
  } catch (error) {
    if (!(error instanceof LetterboxdMovedError)) throw error;
    const moved = await resolveRef(error.ref);
    return {
      ref: moved,
      page: await readPage(sourcePath(moved), 1, forceRefresh),
    };
  }
}

async function fetchSource(
  ref: string,
  ctx: ProviderContext,
): Promise<SourceSnapshot> {
  await assertLetterboxdNotHalted();
  let base = sourcePath(ref);
  const diary = isDiaryPath(base);
  const films = new Map<string, LetterboxdFilm>();
  const signatures = new Set<string>();
  let complete = false;
  let interrupted = false;
  // Known from the pagination after the first page, for the queue estimate.
  let pages: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rest =
      pages === null ? 0 : Math.max(0, Math.min(pages, MAX_PAGES) - page);
    let result: Awaited<ReturnType<typeof readPage>>;
    try {
      if (page === 1) {
        // A renamed member or list keeps its Catalog: read the new address.
        const first = await readFirstPage(ref, ctx.forceRefresh);
        base = sourcePath(first.ref);
        result = first.page;
      } else
        result = await readPage(
          base,
          page,
          ctx.forceRefresh,
          rest * PAGE_ESTIMATE_MS,
        );
    } catch (error) {
      // The queue is long: keep the pages read so far when the caller can
      // serve them. The next read resumes from the cached pages.
      if (
        page > 1 &&
        error instanceof LetterboxdBusyError &&
        currentReadQueue().partial
      ) {
        interrupted = true;
        break;
      }
      throw error;
    }
    pages ??= result.pages ?? null;
    // A diary repeats a film on each viewing, so two pages can list the same
    // films; their watch dates still tell the pages apart.
    const signature = result.films
      .map((film) => (diary ? `${film.uid}@${film.watchedAt ?? ""}` : film.uid))
      .join(",");
    if (signature && signatures.has(signature))
      throw new SourceUnavailableError(
        "unavailable",
        "Letterboxd repeated a page",
      );
    signatures.add(signature);
    for (const film of result.films) {
      // A diary lists one row per viewing; keep each Title once, with its most
      // recent watch date.
      const previous = films.get(film.uid);
      if (
        diary &&
        previous &&
        (previous.watchedAt ?? "") >= (film.watchedAt ?? "")
      )
        continue;
      films.set(film.uid, film);
    }
    if (result.complete) {
      complete = true;
      break;
    }
  }
  const ordered = [...films.values()];
  if (diary)
    ordered.sort((a, b) =>
      (a.watchedAt ?? "").localeCompare(b.watchedAt ?? ""),
    );
  else if (ref.endsWith("/watchlist")) ordered.reverse();
  return {
    complete,
    ...(interrupted ? { interrupted } : {}),
    entries: ordered.map((film) => ({
      title: film.title,
      year: film.year,
      sourceUrl: `https://letterboxd.com/film/${film.slug}/`,
      externalIds: { letterboxd: { uid: film.uid, slug: film.slug } },
      ...(film.watchedAt ? { addedAt: `${film.watchedAt}T00:00:00.000Z` } : {}),
    })),
  };
}

const filmLinksStrategy: ResolverStrategy = {
  name: "letterboxd-film-links",
  provider: "letterboxd",
  batchSize: 1,
  async resolve(entries) {
    const found = new Map<number, string>();
    for (const [index, entry] of entries.entries()) {
      const slug = entry.externalIds?.letterboxd?.slug;
      if (!slug || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)) continue;
      const $ = load(
        await readHtml(`https://letterboxd.com/film/${slug}/`, "film"),
      );
      const ids = new Set<string>();
      $('a[data-track-action="IMDb"][href]').each((_, node) => {
        const href = $(node).attr("href");
        if (!href) return;
        try {
          const url = new URL(href);
          const match = /^\/title\/(tt\d+)(?:\/maindetails)?\/?$/.exec(
            url.pathname,
          );
          if (["imdb.com", "www.imdb.com"].includes(url.hostname) && match)
            ids.add(match[1]);
        } catch {
          /* Relative links do not identify an IMDb title. */
        }
      });
      if (ids.size === 1) {
        const imdbId = ids.values().next().value;
        if (imdbId) found.set(index, imdbId);
      }
    }
    return found;
  },
};

export const letterboxdProvider: ProviderAdapter = {
  id: "letterboxd",
  freshnessMs: LETTERBOXD_FRESHNESS_MS,
  queuedReads: true,
  async validateSource(ref) {
    await assertLetterboxdNotHalted();
    // A renamed member or list is stored at its new address.
    const { ref: resolved, page } = await readFirstPage(await resolveRef(ref));
    return {
      ok: true,
      ref: resolved,
      suggestedTitle: suggestTitle(resolved, page.title),
      defaultDisplayMode: "split",
    };
  },
  fetchSource,
  resolutionKey: (entry) =>
    entry.externalIds?.letterboxd
      ? {
          namespace: "letterboxd",
          externalId: entry.externalIds.letterboxd.uid,
        }
      : null,
  resolverStrategies: [
    wikidataStrategy(
      "letterboxd-wikidata-id",
      "P6127",
      (entry) => entry.externalIds?.letterboxd?.uid,
    ),
    wikidataStrategy(
      "letterboxd-wikidata-slug",
      "P6127",
      (entry) => entry.externalIds?.letterboxd?.slug,
    ),
    filmLinksStrategy,
  ],
};
