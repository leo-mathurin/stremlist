import {
  CONFIGURE_SEO,
  SITE,
  absoluteUrl,
  structuredData,
} from "../content/site";
import { getMarkdownPage, markdownPath } from "./md/registry";

type HeadTag =
  | { tag: "meta" | "link"; attrs: Record<string, string> }
  | { tag: "title" | "script"; attrs: Record<string, string>; content: string };

function meta(
  attr: "name" | "property",
  values: Record<string, string>,
): HeadTag[] {
  return Object.entries(values).map(([key, content]) => ({
    tag: "meta",
    attrs: { [attr]: key, content },
  }));
}

export function headTags(path: string): HeadTag[] {
  const page = getMarkdownPage(path);
  const { title, description, robots } = page
    ? {
        title: page.seoTitle,
        description: page.description,
        robots: "index, follow",
      }
    : path === "/configure"
      ? CONFIGURE_SEO
      : {
          title: `Page not found - ${SITE.name}`,
          description: "The requested Stremlist page could not be found.",
          robots: "noindex, nofollow",
        };
  const canonical = absoluteUrl(page?.path ?? "/");
  return [
    { tag: "title", attrs: {}, content: title },
    ...meta("name", { description, robots }),
    ...["og", "twitter"].flatMap((prefix) =>
      meta("property", {
        [`${prefix}:title`]: title,
        [`${prefix}:description`]: description,
        [`${prefix}:url`]: canonical,
        [`${prefix}:image`]: absoluteUrl(SITE.image),
      }),
    ),
    { tag: "link", attrs: { rel: "canonical", href: canonical } },
    ...(page
      ? [
          ...meta("name", { "ai-summary": page.summary }),
          {
            tag: "link" as const,
            attrs: {
              rel: "alternate",
              type: "text/markdown",
              href: absoluteUrl(markdownPath(page.path)),
            },
          },
        ]
      : []),
    ...(page?.path === "/"
      ? [
          {
            tag: "script" as const,
            attrs: { type: "application/ld+json" },
            content: JSON.stringify(structuredData()).replace(/</g, "\\u003c"),
          },
        ]
      : []),
  ];
}
