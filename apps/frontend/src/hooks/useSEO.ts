import { useEffect } from "react";
import { SITE, absoluteUrl, structuredData } from "../content/site";
import { getMarkdownPage, markdownPath } from "../lib/md/registry";

interface CustomSEOOptions {
  title: string;
  description: string;
  robots?: string;
  canonical?: string;
}

type SEOOptions = CustomSEOOptions | { path: string };

const DEFAULTS = {
  title: SITE.title,
  description: SITE.description,
  robots: "index, follow",
  canonical: absoluteUrl("/"),
};

function setMetaTag(
  attr: "name" | "property",
  key: string,
  content: string,
): void {
  const selector = `meta[${attr}="${key}"]`;
  const el = document.querySelector<HTMLMetaElement>(selector);
  const tag = el ?? document.createElement("meta");
  tag.setAttribute(attr, key);
  tag.setAttribute("content", content);
  if (!el) document.head.append(tag);
}

function setCanonical(href: string | undefined): void {
  const el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const tag = el ?? document.createElement("link");
  tag.rel = "canonical";
  tag.href = href ?? DEFAULTS.canonical;
  if (!el) document.head.append(tag);
}

export function useSEO(options: SEOOptions) {
  const page = "path" in options ? getMarkdownPage(options.path) : undefined;
  const { title, description, robots, canonical }: CustomSEOOptions =
    "path" in options
      ? {
          title: page?.seoTitle ?? DEFAULTS.title,
          description: page?.description ?? DEFAULTS.description,
          robots: page ? DEFAULTS.robots : "noindex, nofollow",
          canonical: page ? absoluteUrl(page.path) : undefined,
        }
      : options;
  useEffect(() => {
    document.title = title;
    setMetaTag("name", "description", description);
    setMetaTag("name", "robots", robots ?? DEFAULTS.robots);
    setCanonical(canonical);

    document.querySelector('meta[name="ai-summary"]')?.remove();
    document
      .querySelector('link[rel="alternate"][type="text/markdown"]')
      ?.remove();
    document.querySelector('script[type="application/ld+json"]')?.remove();
    if (page) {
      setMetaTag("name", "ai-summary", page.summary);
      const alternate = document.createElement("link");
      alternate.rel = "alternate";
      alternate.type = "text/markdown";
      alternate.href = absoluteUrl(markdownPath(page.path));
      document.head.append(alternate);
      if (page.path === "/") {
        const schema = document.createElement("script");
        schema.type = "application/ld+json";
        schema.textContent = JSON.stringify(structuredData());
        document.head.append(schema);
      }
    }

    setMetaTag("property", "og:title", title);
    setMetaTag("property", "og:description", description);
    if (canonical) setMetaTag("property", "og:url", canonical);

    setMetaTag("property", "twitter:title", title);
    setMetaTag("property", "twitter:description", description);
    if (canonical) setMetaTag("property", "twitter:url", canonical);

    return () => {
      document.title = DEFAULTS.title;
      setMetaTag("name", "description", DEFAULTS.description);
      setMetaTag("name", "robots", DEFAULTS.robots);
      setCanonical(DEFAULTS.canonical);

      setMetaTag("property", "og:title", DEFAULTS.title);
      setMetaTag("property", "og:description", DEFAULTS.description);
      setMetaTag("property", "og:url", DEFAULTS.canonical);

      setMetaTag("property", "twitter:title", DEFAULTS.title);
      setMetaTag("property", "twitter:description", DEFAULTS.description);
      setMetaTag("property", "twitter:url", DEFAULTS.canonical);
    };
  }, [title, description, robots, canonical, page]);
}
