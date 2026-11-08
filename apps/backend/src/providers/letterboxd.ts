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
  withLetterboxdPermit,
} from "./letterboxd-gate";
import { parseLetterboxdPage } from "./letterboxd-page";
import type { LetterboxdFilm } from "./letterboxd-page";
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
// Built-in charts (PUBLIC_SOURCES): the reference is the path body.
const CHART = /^films\/popular\/this\/(?:week|month)$/;
const MAX_PAGES = 100;
type PageRead =
  | { ok: true; html: string }
  | { ok: false; reason: SourceProblemReason };

const SHARE_PREFIX = "share/";
const PROVISIONAL_SHARE_PREFIX = "lbxshare/";
const SHORT_PREFIX = "lbxshort/";

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
  if (CHART.test(ref)) return `/${ref}/`;
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
    { ok: true; url: string } | { ok: false; reason: SourceProblemReason }
  >(async () => {
    try {
      const response = await providerFetch(`https://boxd.it/${code}`, {
        redirect: "manual",
        timeoutMs: 10_000,
        retryOn429: false,
        headers: { Accept: "text/html" },
      });
      await response.body?.cancel();
      const blocked =
        response.status === 403 ||
        response.headers.get("cf-mitigated") === "challenge";
      if (blocked || response.status === 429)
        return {
          value: { ok: false, reason: "unavailable" },
          result: blocked ? "blocked" : "rate_limited",
          retryAfterMs: retryAfterOf(response),
        };
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location)
        return { value: { ok: true, url: location }, result: "ok" };
      return {
        value: {
          ok: false,
          reason: response.status === 404 ? "not_found" : "unavailable",
        },
        result: response.status >= 500 ? "failed" : "ok",
      };
    } catch {
      return { value: { ok: false, reason: "unavailable" }, result: "failed" };
    }
  });
  if (!read.ok)
    throw new SourceUnavailableError(
      read.reason,
      "Letterboxd could not resolve this short link",
    );
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
  page: { diary?: boolean; fragment?: boolean } = {},
) {
  if (!isProviderEnabled("letterboxd"))
    throw new SourceUnavailableError("disabled", "Letterboxd is turned off");
  const read = await withLetterboxdPermit<PageRead>(async () => {
    let blocked = false;
    let retryAfterMs = 0;
    try {
      const response = await providerFetch(url, {
        redirect: "manual",
        timeoutMs: 10_000,
        retryOn429: false,
        headers: { Accept: "text/html" },
      });
      blocked =
        response.status === 403 ||
        response.headers.get("cf-mitigated") === "challenge";
      retryAfterMs = retryAfterOf(response);
      if (blocked || (response.status !== 200 && response.status < 500)) {
        await response.body?.cancel();
        return {
          value: {
            ok: false,
            reason: response.status === 404 ? "not_found" : "unavailable",
          },
          result: blocked
            ? "blocked"
            : response.status === 429
              ? "rate_limited"
              : "ok",
          retryAfterMs,
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
        };
      }
      return {
        value: blocked
          ? { ok: false, reason: "unavailable" }
          : { ok: true, html },
        result: blocked ? "blocked" : "ok",
      };
    } catch {
      // A body timeout after HTTP 200 is still a failed read, never valid empty content.
      return {
        value: { ok: false, reason: "unavailable" },
        result: blocked ? "blocked" : "failed",
        retryAfterMs,
      };
    }
  });
  if (!read.ok)
    throw new SourceUnavailableError(
      read.reason,
      "Letterboxd could not read this public list",
    );
  return read.html;
}

function pagePath(base: string, page: number) {
  return page === 1 ? base : `${base}page/${page}/`;
}

/** A chart's path: its page loads the grid from a fragment with JavaScript. */
function isChartPath(base: string) {
  return CHART.test(base.slice(1, -1));
}

async function readPage(base: string, page: number, forceRefresh = false) {
  const path = pagePath(base, page);
  const key = `providers/letterboxd/pages-v1/${createHash("sha256").update(path).digest("hex")}.json`;
  const options = { diary: isDiaryPath(base), fragment: isChartPath(base) };
  // The fragment links to the chart's own next page, like a full page does.
  const url = options.fragment
    ? `https://letterboxd.com/csi/films/films-browser-list${path.slice("/films".length)}?esiAllowFilters=true`
    : `https://letterboxd.com${path}`;
  return letterboxdSnapshot(
    key,
    async () => {
      const parsed = parseLetterboxdPage(
        await readHtml(
          url,
          "collection",
          `https://letterboxd.com${pagePath(base, page + 1)}`,
          options,
        ),
        options,
      );
      return {
        films: parsed.films,
        complete: parsed.next === null,
        title: parsed.title,
      };
    },
    forceRefresh,
  );
}

async function fetchSource(
  ref: string,
  ctx: ProviderContext,
): Promise<SourceSnapshot> {
  await assertLetterboxdNotHalted();
  const base = sourcePath(ref);
  const diary = isDiaryPath(base);
  const films = new Map<string, LetterboxdFilm>();
  const signatures = new Set<string>();
  // A chart ranks every film on Letterboxd (over a million): its Source list
  // is the first page, the top 72.
  const chart = isChartPath(base);
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await readPage(base, page, ctx.forceRefresh);
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
    if (result.complete || chart) {
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
  async validateSource(ref) {
    await assertLetterboxdNotHalted();
    const resolved = await resolveRef(ref);
    const page = await readPage(sourcePath(resolved), 1);
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
