import {
  PROVIDER_IDS,
  PROVIDERS,
} from "../../../../../packages/shared/src/providers";
import { VERSIONS } from "../../content/changelog";
import {
  HOME,
  STEPS,
  FEATURES,
  FIND_PLACES,
  TROUBLESHOOTING,
} from "../../content/home";
import { LEGAL_SECTIONS, LEGAL_UPDATED } from "../../content/terms";
import { SITE, absoluteUrl } from "../../content/site";
import { date, heading, link, list, table, text } from "./format";

interface RenderContext {
  userCount: number | null;
}

interface MarkdownPage {
  path: string;
  title: string;
  seoTitle: string;
  description: string;
  summary: string;
  updated: string;
  section: "Core pages" | "Optional";
  render: (context: RenderContext) => string;
}

export const SKIPPED_HTML_ROUTES: Readonly<Record<string, string>> = {
  "/configure": "Noindex configuration page with private Account data.",
  "*": "Noindex error page for unknown routes.",
};

// Real Markdown files bypass suffix handling; none exist in this app today.
export const PASSTHROUGH_MARKDOWN_ROUTES: readonly string[] = [];

export const PRIVATE_PATHS = [
  "/configure",
  "/api/",
  "/oauth/",
  "/*/configure",
  "/*/actions/",
  "/*/manifest.json",
  "/*/catalog/",
  "/*/meta/",
  "/*/stream/",
  "/admin",
  "/dashboard",
  "/auth",
];

function home({ userCount }: RenderContext): string {
  return [
    text(HOME.intro),
    ...(userCount === null
      ? []
      : [
          `${userCount.toLocaleString("en")} ${userCount === 1 ? "person uses" : "people use"} ${SITE.name}.`,
        ]),
    heading(2, HOME.providersTitle),
    text(HOME.providersLead),
    table(
      ["Provider", "Availability"],
      PROVIDER_IDS.map((id) => [
        PROVIDERS[id].label,
        PROVIDERS[id].availability === "available" ? "Available" : "Soon",
      ]),
    ),
    heading(2, HOME.pasteTitle),
    text(HOME.pasteBody),
    heading(2, HOME.connectTitle),
    text(HOME.connectBody),
    heading(2, HOME.previewTitle),
    text(HOME.previewLead),
    heading(2, HOME.stepsTitle),
    ...STEPS.map(
      ([title, body], index) =>
        `${index + 1}. **${text(title)}**: ${text(body)}`,
    ),
    heading(2, HOME.featuresTitle),
    ...FEATURES.flatMap(([title, body]) => [heading(3, title), text(body)]),
    heading(2, HOME.findTitle),
    text(HOME.findLead),
    list(
      FIND_PLACES.map(([title, body]) => `**${text(title)}**: ${text(body)}`),
    ),
    `${text(HOME.addonManager)} ${link("Stremio Addon Manager", SITE.addonManager)}.`,
    heading(2, HOME.troubleshootingTitle),
    text(HOME.troubleshootingLead),
    ...TROUBLESHOOTING.flatMap(([question, answer]) => [
      heading(3, question),
      text(answer),
    ]),
    `${text(HOME.disclaimer)} ${link("terms and privacy policy", "/terms")}.`,
  ].join("\n\n");
}

function terms(): string {
  return [
    "How Stremlist works, what it stores, and what you can ask for.",
    ...LEGAL_SECTIONS.flatMap((section) => [
      heading(2, section.label),
      `Last updated: ${LEGAL_UPDATED}`,
      ...section.clauses.flatMap((clause) => [
        heading(3, clause.title),
        ...clause.blocks.map((block) =>
          block.kind === "paragraph"
            ? block.text
                .split(SITE.contact)
                .map(text)
                .join(link(SITE.contact, `mailto:${SITE.contact}`))
            : list(
                block.items.map(
                  (item) => `**${text(item.label)}** ${text(item.text)}`,
                ),
              ),
        ),
      ]),
    ]),
  ].join("\n\n");
}

function changelog(): string {
  return [
    "A history of updates and improvements to Stremlist.",
    ...VERSIONS.flatMap((version) => [
      heading(2, version.version),
      date(version.date),
      list(
        version.changes.map(
          (change) => `**${text(change.label)}**: ${text(change.text)}`,
        ),
      ),
    ]),
  ].join("\n\n");
}

const pages: readonly MarkdownPage[] = [
  {
    path: "/",
    title: HOME.title,
    seoTitle: SITE.title,
    description: SITE.description,
    summary: `${SITE.description} Paste public list links or connect a Trakt, Simkl or MDBList account to create catalogs in Stremio.`,
    updated: "2026-10-10",
    section: "Core pages",
    render: home,
  },
  {
    path: "/changelog",
    title: "Changelog",
    seoTitle: `Changelog - ${SITE.name}`,
    description:
      "See what's new in Stremlist. A history of updates and improvements to the Stremio addon for your watchlists and lists.",
    summary:
      "A dated history of Stremlist releases, features, fixes and performance improvements.",
    updated: date(VERSIONS[0].date),
    section: "Core pages",
    render: changelog,
  },
  {
    path: "/terms",
    title: "Terms and privacy",
    seoTitle: `Terms & Privacy - ${SITE.name}`,
    description:
      "Terms of service and privacy policy for Stremlist, the free Stremio addon for your watchlists and lists.",
    summary:
      "Terms of service and privacy policy for Stremlist, the free Stremio addon for your watchlists and lists.",
    updated: LEGAL_UPDATED,
    section: "Optional",
    render: terms,
  },
];

export function listMarkdownRoutes() {
  return pages;
}

export function markdownPath(path: string): string {
  return path === "/" ? "/index.md" : `${path}.md`;
}

export function getMarkdownPage(path: string) {
  const normalized = path === "/" ? path : path.replace(/\/$/, "");
  return pages.find((page) => page.path === normalized);
}

export function renderMarkdownPage(
  page: MarkdownPage,
  context: RenderContext,
): string {
  return (
    [
      heading(1, page.title),
      `> ${text(page.description)}`,
      `Canonical: ${absoluteUrl(page.path)}\nLast updated: ${page.updated}`,
      page.render(context),
      heading(2, "Related"),
      list(
        pages
          .filter((related) => related.path !== page.path)
          .map((related) => link(related.title, related.path)),
      ),
    ].join("\n\n") + "\n"
  );
}
