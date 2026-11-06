import { load } from "cheerio";
import { z } from "zod";

const letterboxdFilmSchema = z.object({
  uid: z.string().regex(/^film:\d+$/),
  slug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
  title: z.string().min(1),
  year: z.number().int().min(1870).max(2200).optional(),
});
export type LetterboxdFilm = z.infer<typeof letterboxdFilmSchema>;
export const letterboxdSnapshotSchema = z.object({
  films: z.array(letterboxdFilmSchema).max(4000),
  complete: z.boolean(),
  title: z.string(),
});

export function parseLetterboxdPage(html: string) {
  const $ = load(html, { sourceCodeLocationInfo: true });
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
  const empty = films.length === 0 && emptyGrid;
  const next = $("a.next, a[rel='next']").first().attr("href") ?? null;
  if ($("a.next, a[rel='next']").length > 0 && !next?.trim())
    invalid.push("pagination");
  return {
    films,
    next,
    blocked,
    valid:
      !blocked &&
      completeDocument &&
      invalid.length === 0 &&
      /Letterboxd/i.test(title) &&
      (films.length > 0 || empty),
    title: $("h1").first().text().trim() || title.replace(/\s*[•|].*$/, ""),
  };
}
