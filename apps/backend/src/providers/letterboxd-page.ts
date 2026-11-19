import { load } from "cheerio";
import { z } from "zod";

const letterboxdFilmSchema = z.object({
  uid: z.string().regex(/^film:\d+$/),
  slug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
  title: z.string().min(1),
  year: z.number().int().min(1870).max(2200).optional(),
  watchedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type LetterboxdFilm = z.infer<typeof letterboxdFilmSchema>;
export const letterboxdSnapshotSchema = z.object({
  films: z.array(letterboxdFilmSchema).max(4000),
  complete: z.boolean(),
  title: z.string(),
  /** The number of pages that the pagination shows, when it shows one. */
  pages: z.number().int().positive().optional(),
});

function diaryDate($: ReturnType<typeof load>, card: ReturnType<typeof $>) {
  const row = card.closest("tr.diary-entry-row");
  if (row.length === 0) return undefined;
  for (const node of row.find("a[href*='/for/']").toArray()) {
    const match = /\/for\/(\d{4})\/(\d{2})\/(\d{2})\/?$/.exec(
      $(node).attr("href") ?? "",
    );
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return undefined;
}

/**
 * Whether a 403 body is Letterboxd's own Forbidden page, which it sends for a
 * private watchlist. A refusal of Stremlist comes from Cloudflare instead,
 * with its own page. The markers are in the first 2 KB.
 */
export function isLetterboxdForbiddenPage(html: string) {
  return (
    /<title>\s*Letterboxd - Forbidden\s*<\/title>/i.test(html) ||
    /analytic_params\['template'\]\s*=\s*'\/errors\/forbidden'/.test(html)
  );
}

/**
 * Parse one Letterboxd collection page. `diary` reads diary rows and their
 * watch dates.
 */
export function parseLetterboxdPage(html: string, { diary = false } = {}) {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const closed = (selector: string) =>
    $(selector)
      .toArray()
      .some((node) => {
        const location = node.sourceCodeLocation;
        return Boolean(location && "endTag" in location && location.endTag);
      });
  const completeDocument = Boolean(
    $("html").get(0)?.sourceCodeLocation?.endTag &&
    $("body").get(0)?.sourceCodeLocation?.endTag,
  );
  const title = $("title").text().trim();
  const blocked =
    (!/Letterboxd/i.test(title) &&
      /^(Just a moment|Attention Required|Access Denied)/i.test(title)) ||
    $("form#challenge-form, .cf-error-details").length > 0 ||
    /Access is temporarily restricted/i.test(
      $("main, #challenge-stage").text(),
    );
  const films: LetterboxdFilm[] = [];
  const invalid: string[] = [];
  $("[data-postered-identifier]").each((_, node) => {
    const card = $(node);
    let identifier: unknown;
    try {
      identifier = JSON.parse(card.attr("data-postered-identifier") ?? "null");
    } catch {
      invalid.push("poster");
      return;
    }
    const uid = z.object({ uid: z.string() }).safeParse(identifier);
    if (!uid.success || !uid.data.uid.startsWith("film:")) {
      invalid.push("identifier");
      return;
    }
    const name = card.attr("data-item-name") ?? "";
    const match = /^(.*?)\s*\((\d{4})\)$/.exec(name);
    const parsed = letterboxdFilmSchema.safeParse({
      uid: uid.data.uid,
      slug: card.attr("data-item-slug"),
      title: match?.[1] ?? name,
      year: match ? Number(match[2]) : undefined,
      watchedAt: diary ? diaryDate($, card) : undefined,
    });
    if (!parsed.success) {
      invalid.push("poster");
      return;
    }
    films.push(parsed.data);
  });
  const emptyGrid = $("ul.poster-list.-grid")
    .toArray()
    .some(
      (node) =>
        Boolean(node.sourceCodeLocation?.endTag) &&
        $(node).children().length === 0 &&
        !$(node).text().trim(),
    );
  const empty = diary
    ? films.length === 0 &&
      closed("table#diary-table") &&
      $("tr.diary-entry-row").length === 0
    : films.length === 0 && (emptyGrid || closed("main section.empty-text"));
  const next = $("a.next, a[rel='next']").first().attr("href") ?? null;
  if ($("a.next, a[rel='next']").length > 0 && !next?.trim())
    invalid.push("pagination");
  const pages = Math.max(
    0,
    ...$(".paginate-pages a[href]")
      .toArray()
      .map((node) =>
        Number(/\/page\/(\d+)\/?$/.exec($(node).attr("href") ?? "")?.[1] ?? 0),
      ),
  );
  return {
    films,
    next,
    pages: pages > 0 ? pages : null,
    blocked,
    valid:
      !blocked &&
      invalid.length === 0 &&
      completeDocument &&
      /Letterboxd/i.test(title) &&
      (films.length > 0 || empty),
    title: $("h1").first().text().trim() || title.replace(/\s*[•|].*$/, ""),
  };
}
