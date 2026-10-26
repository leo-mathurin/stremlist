import { SITE, absoluteUrl } from "../../content/site";
import { heading, link, list } from "./format";
import {
  listMarkdownRoutes,
  markdownPath,
  PRIVATE_PATHS,
  renderMarkdownPage,
} from "./registry";

export const DISCOVERY_PATHS = [
  "/llms.txt",
  "/llms-full.txt",
  "/ai.txt",
  "/robots.txt",
  "/sitemap.xml",
  "/api/md/_catalog",
];

export function sitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listMarkdownRoutes()
    .map((page) => `  <url><loc>${absoluteUrl(page.path)}</loc></url>`)
    .join("\n")}\n</urlset>\n`;
}

export function discoveryLinks(): string {
  return ["/llms.txt", "/llms-full.txt", "/ai.txt"]
    .map((path) => `<${absoluteUrl(path)}>; rel="describedby"`)
    .join(", ");
}

export function llms(): string {
  return (
    [
      heading(1, SITE.name),
      `> ${SITE.description}`,
      `Stremlist is free. Contact: ${link(SITE.contact, `mailto:${SITE.contact}`)}.`,
      "<!-- Keep in sync with /robots.txt and /ai.txt; generated from the shared site config and Markdown registry. -->",
      ...(["Core pages", "Optional"] as const).flatMap((section) => [
        heading(2, section),
        list(
          listMarkdownRoutes()
            .filter((page) => page.section === section)
            .map(
              (page) =>
                `${link(page.path === "/" ? "Home" : page.title, markdownPath(page.path))}: ${page.description}`,
            ),
        ),
      ]),
      heading(2, "Machine-readable"),
      list([
        `${link("Full content", "/llms-full.txt")}: All public pages in one response.`,
        `${link("Markdown catalog", "/api/md/_catalog")}: Every public Markdown route.`,
        `${link("Sitemap", "/sitemap.xml")}: Canonical HTML pages.`,
        `${link("AI usage policy", "/ai.txt")}: Permissions, restrictions and attribution.`,
      ]),
    ].join("\n\n") + "\n"
  );
}

export function fullContent(userCount: number | null): string {
  const content =
    [
      heading(1, `${SITE.name} - full content`),
      `> ${SITE.description}`,
      `Generated: ${new Date().toISOString().slice(0, 10)}`,
      ...listMarkdownRoutes().map(
        (page) =>
          `---\n<!-- source: ${absoluteUrl(page.path)} -->\n${renderMarkdownPage(page, { userCount })}`,
      ),
    ].join("\n\n") + "\n";
  if (content.length > 500_000)
    console.warn("Public Markdown content exceeds 500,000 characters", {
      characters: content.length,
    });
  return content;
}

export function catalog() {
  return listMarkdownRoutes().map((page) => ({
    path: page.path,
    title: page.title,
    description: page.description,
    canonical: absoluteUrl(page.path),
    markdown: absoluteUrl(markdownPath(page.path)),
    api: absoluteUrl(`/api/md${page.path}`),
    updated: page.updated,
    includedInFull: true,
  }));
}

export function aiPolicy(): string {
  return `# AI usage policy for ${SITE.name}

Website: ${SITE.url}
Last Updated: ${SITE.policyUpdated}
# Keep in sync with /robots.txt and /llms.txt; generated from the shared site config and Markdown registry.

[identity]
Name: ${SITE.name}
URL: ${SITE.url}
Description: ${SITE.description}
Contact: ${SITE.contact}

[permissions]
- Summarise public content.
- Quote with attribution and cite canonical HTML URLs.
- Index public content for search results and answers.
- Use public content for AI model training.

[restrictions]
- Do not fabricate quotes, reviews or ratings.
- Do not present our content as the model's own work.
- Do not access, disclose or train on private Account data, Connections or Addon URLs.

[attribution]
Cite ${SITE.name} and the canonical HTML URL for the source page.

[scope]
Included HTML paths: ${listMarkdownRoutes()
    .map((page) => page.path)
    .join(", ")}
Included machine-readable paths: ${listMarkdownRoutes()
    .map((page) => markdownPath(page.path))
    .join(
      ", ",
    )}, /api/md/, /llms.txt, /llms-full.txt, /ai.txt, /robots.txt, /sitemap.xml
Excluded paths: ${PRIVATE_PATHS.join(", ")}
The /api/md/ discovery and public Markdown endpoints are allowed exceptions to /api/.

[contact]
Email: ${SITE.contact}
URL: mailto:${SITE.contact}
`;
}

export function robots(): string {
  const bots = [
    "*",
    "OAI-SearchBot",
    "ChatGPT-User",
    "Claude-SearchBot",
    "Claude-User",
    "PerplexityBot",
    "Perplexity-User",
    "GPTBot",
    "ClaudeBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "Bytespider",
  ];
  return (
    [
      "# Keep in sync with /llms.txt and /ai.txt; generated from the shared site config and Markdown registry.",
      ...bots.map((bot) =>
        [
          `User-agent: ${bot}`,
          "Allow: /",
          "Allow: /api/md/",
          ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
        ].join("\n"),
      ),
      `Sitemap: ${absoluteUrl("/sitemap.xml")}`,
    ].join("\n\n") + "\n"
  );
}
