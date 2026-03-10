import { useEffect } from "react";

interface SEOOptions {
  title: string;
  description: string;
  robots?: string;
  canonical?: string;
}

const DEFAULTS = {
  title: "Stremlist - IMDb Watchlist for Stremio",
  description:
    "Connect your IMDb watchlist directly to Stremio. A free addon that syncs your IMDb watchlist with Stremio's streaming platform.",
  robots: "index, follow",
  canonical: "https://stremlist.com/",
};

function setMetaTag(
  attr: "name" | "property",
  key: string,
  content: string,
): void {
  const selector = `meta[${attr}="${key}"]`;
  const el = document.querySelector<HTMLMetaElement>(selector);
  if (el) {
    el.setAttribute("content", content);
  }
}

function setCanonical(href: string | undefined): void {
  const el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (el) {
    el.setAttribute("href", href ?? DEFAULTS.canonical);
  }
}

export function useSEO({ title, description, robots, canonical }: SEOOptions) {
  useEffect(() => {
    document.title = title;
    setMetaTag("name", "description", description);
    setMetaTag("name", "robots", robots ?? DEFAULTS.robots);
    setCanonical(canonical);

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
  }, [title, description, robots, canonical]);
}
