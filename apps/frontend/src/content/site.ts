export const SITE = {
  name: "Stremlist",
  url: "https://stremlist.com",
  title: "Stremlist - Your watchlists and lists, all in Stremio",
  description:
    "Free Stremio addon that shows your watchlists and lists from IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique as catalogs in Stremio.",
  contact: "me@leomathurin.com",
  logo: "/icon.png",
  image: "/og-image.png",
  repository: "https://github.com/leo-mathurin/stremlist",
  author: "https://leomathurin.com",
  addonManager: "https://stremio-addon-manager.vercel.app/",
  policyUpdated: "2026-10-26",
};

export const CONFIGURE_SEO = {
  title: `Configure - ${SITE.name}`,
  description:
    "Choose the watchlists and lists that Stremlist shows in Stremio, from IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique.",
  robots: "noindex, nofollow",
};

export function absoluteUrl(path: string): string {
  return new URL(path, `${SITE.url}/`).href;
}

function organization() {
  return {
    "@type": "Organization",
    "@id": absoluteUrl("/#organization"),
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    logo: absoluteUrl(SITE.logo),
    email: SITE.contact,
    sameAs: [SITE.repository],
  };
}

export function structuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organization(),
      {
        "@type": "WebSite",
        "@id": absoluteUrl("/#website"),
        name: SITE.name,
        url: SITE.url,
        description: SITE.description,
        publisher: { "@id": absoluteUrl("/#organization") },
      },
      {
        "@type": "SoftwareApplication",
        name: SITE.name,
        description: SITE.description,
        applicationCategory: "Entertainment",
        operatingSystem: "Any",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
    ],
  };
}
