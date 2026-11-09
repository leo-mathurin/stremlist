import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  PROVIDER_IDS,
  PROVIDERS,
} from "../../../packages/shared/src/providers";
import { VERSIONS } from "../src/content/changelog";
import { CONFIGURE_SEO, SITE } from "../src/content/site";
import { LEGAL_SECTIONS, LEGAL_UPDATED } from "../src/content/terms";
import { aiPolicy, llms, sitemap } from "../src/lib/md/discovery";
import { date } from "../src/lib/md/format";
import {
  getMarkdownPage,
  listMarkdownRoutes,
  renderMarkdownPage,
} from "../src/lib/md/registry";

const providerLabels = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].availability === "available",
).map((id) => PROVIDERS[id].label);

function legalText(sectionId: string): string {
  const section = LEGAL_SECTIONS.find((item) => item.id === sectionId);
  assert.ok(section, sectionId);
  return section.clauses
    .flatMap((clause) => [
      clause.title,
      ...clause.blocks.flatMap((block) =>
        typeof block === "string"
          ? [block]
          : block.map((item) => `${item.label} ${item.text}`),
      ),
    ])
    .join("\n");
}

function page(path: string) {
  const found = getMarkdownPage(path);
  assert.ok(found, path);
  return found;
}

test("public descriptions name every available Provider", async () => {
  const indexHtml = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const keywords = /name="keywords"\s+content="([^"]+)"/.exec(indexHtml)?.[1];
  const places: Record<string, string> = {
    "site description": SITE.description,
    "configure description": CONFIGURE_SEO.description,
    "index.html keywords": keywords ?? "",
    "terms introduction": LEGAL_SECTIONS[0].clauses[0].blocks.join(" "),
    "llms.txt": llms(),
    "index.md": renderMarkdownPage(page("/"), { userCount: null }),
    "ai.txt": aiPolicy(),
  };
  for (const [place, value] of Object.entries(places))
    for (const label of providerLabels)
      assert.ok(value.includes(label), `${place} does not name ${label}`);
});

test("the privacy policy states what is stored and for how long", () => {
  const privacy = legalText("privacy");
  for (const claim of [
    /New titles/,
    /180 days/,
    /Letterboxd/,
    /request log/i,
    /30 days/,
    /AES-256-GCM/,
    /Vercel Web Analytics/,
  ])
    assert.match(privacy, claim);
  for (const wrong of [
    /does not use cookies or any tracking/i,
    /rather than keeping a history/i,
    /not shared with any third parties/i,
  ])
    assert.doesNotMatch(privacy, wrong);
});

test("the privacy policy names every service that receives data", () => {
  const privacy = legalText("privacy");
  for (const service of [
    ...providerLabels,
    "TMDB",
    "Wikidata",
    "Cinemeta",
    "Resend",
    "Supabase",
    "Vercel",
    "Cloudflare R2",
    "RPDB",
  ])
    assert.ok(privacy.includes(service), `privacy policy omits ${service}`);
});

test("public pages carry no em dashes", () => {
  const copy = [
    SITE.title,
    SITE.description,
    CONFIGURE_SEO.description,
    legalText("terms"),
    legalText("privacy"),
    llms(),
    aiPolicy(),
    ...listMarkdownRoutes().map((item) =>
      renderMarkdownPage(item, { userCount: null }),
    ),
  ].join("\n");
  assert.ok(!copy.includes("—"), "em dash in public copy");
});

test("dates of the pages changed for v2 are not older than the v2 release", () => {
  const release = VERSIONS.find((version) => version.version === "v2.0.0");
  assert.ok(release);
  const released = date(release.date);
  for (const [name, updated] of [
    ["home page", page("/").updated],
    ["terms page", page("/terms").updated],
    ["legal text", LEGAL_UPDATED],
    ["AI policy", SITE.policyUpdated],
  ])
    assert.ok(updated >= released, `${name} updated ${updated} < ${released}`);
});

test("the sitemap gives each page its last change date", () => {
  const xml = sitemap();
  for (const item of listMarkdownRoutes())
    assert.ok(
      xml.includes(
        `<url><loc>https://stremlist.com${item.path}</loc><lastmod>${item.updated}</lastmod></url>`,
      ),
      `sitemap has no lastmod for ${item.path}`,
    );
});

test("release dates do not move a day in time zones east of UTC", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Paris";
  try {
    assert.equal(date("November 9, 2026"), "2026-11-09");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
