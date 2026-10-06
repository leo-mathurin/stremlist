import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import {
  CONNECTION_SOURCES,
  PROVIDERS,
  PUBLIC_SOURCES,
} from "@stremlist/shared/providers";
import type {
  ParsedSourceLink,
  ProviderId,
  SourceKind,
} from "@stremlist/shared/providers";

/** Reorders Stremio addons, so Stremlist can sit just after Cinemeta. */
export const ADDON_MANAGER_URL = "https://stremio-addon-manager.vercel.app/";

/** Two-letter marks, so the UI shows no third-party logos. */
export const PROVIDER_MONOGRAMS: Record<ProviderId, string> = {
  imdb: "IM",
  trakt: "TR",
  simkl: "SI",
  mdblist: "MD",
  justwatch: "JW",
  senscritique: "SC",
  letterboxd: "LB",
};

/** Display order on Home and Configure: the most used Providers first. */
export const PROVIDER_ORDER: readonly ProviderId[] = [
  "imdb",
  "trakt",
  "simkl",
  "mdblist",
  "justwatch",
  "senscritique",
  "letterboxd",
];

const KIND_LABELS: Record<SourceKind, string> = {
  watchlist: "Watchlist",
  list: "List",
  chart: "Chart",
  recommendations: "Recommendations",
  up_next: "Up Next",
  history: "History",
  collection: "Collection",
  status: "Status",
};

/** The live hint under a link field, such as "Trakt watchlist detected". */
export function detectedLinkHint(parsed: ParsedSourceLink): string {
  const info = PROVIDERS[parsed.provider];
  if (info.availability !== "available") return `${info.label}: coming soon`;
  return `${info.label} ${KIND_LABELS[parsed.kind].toLowerCase()} detected`;
}

export interface SourceDescription {
  kind: SourceKind;
  kindLabel: string;
  /** Short human reference, such as a username or a list ID. */
  detail: string | null;
  /** The Source list page on its Provider, when Stremlist can build it. */
  url: string | null;
  /** A title to suggest when the user has not set one. */
  suggestedTitle: string;
}

/** Whether a ref is one of the fixed connection or public sources. */
export function isStaticSource(provider: ProviderId, ref: string): boolean {
  return knownSource(provider, ref) !== null;
}

function knownSource(provider: ProviderId, ref: string) {
  return (
    CONNECTION_SOURCES[provider]?.find((source) => source.ref === ref) ??
    PUBLIC_SOURCES[provider]?.find((source) => source.ref === ref) ??
    null
  );
}

/**
 * Describe a stored Source list reference for the configure page. The
 * reference formats are the ones in `@stremlist/shared/providers`.
 */
export function describeSource(
  provider: ProviderId,
  ref: string,
): SourceDescription {
  const label = PROVIDERS[provider].label;
  const known = knownSource(provider, ref);
  if (known) {
    const fromConnection = ref.startsWith("me/");
    return {
      kind: known.kind,
      kindLabel: KIND_LABELS[known.kind],
      detail: fromConnection ? "Your account" : null,
      url:
        provider === "trakt" && !fromConnection
          ? `https://trakt.tv/movies/${ref}`
          : null,
      suggestedTitle: `${label} ${known.label}`,
    };
  }

  const describe = (
    kind: SourceKind,
    detail: string | null,
    url: string | null,
    suggestedTitle?: string,
  ): SourceDescription => ({
    kind,
    kindLabel: KIND_LABELS[kind],
    detail,
    url,
    suggestedTitle: suggestedTitle ?? `${label} ${KIND_LABELS[kind]}`,
  });

  const parts = ref.split("/");
  switch (provider) {
    case "imdb": {
      const chart = CHART_BY_ID.get(ref);
      if (chart) return describe("chart", null, chart.url, chart.label);
      if (/^ls\d+$/.test(ref)) {
        return describe("list", ref, `https://www.imdb.com/list/${ref}/`);
      }
      return describe(
        "watchlist",
        ref,
        `https://www.imdb.com/user/${ref}/watchlist`,
      );
    }
    case "trakt": {
      if (parts[0] === "users" && parts[2] === "watchlist") {
        return describe(
          "watchlist",
          parts[1],
          `https://trakt.tv/users/${parts[1]}/watchlist`,
          `${parts[1]}'s watchlist`,
        );
      }
      if (parts[0] === "users" && parts[2] === "lists") {
        return describe(
          "list",
          `${parts[1]}/${parts[3]}`,
          `https://trakt.tv/users/${parts[1]}/lists/${parts[3]}`,
        );
      }
      if (parts[0] === "lists") {
        return describe("list", parts[1], `https://trakt.tv/lists/${parts[1]}`);
      }
      return describe("list", ref, null);
    }
    case "mdblist": {
      if (parts[0] === "lists") {
        return describe(
          "list",
          `${parts[1]}/${parts[2]}`,
          `https://mdblist.com/lists/${parts[1]}/${parts[2]}`,
        );
      }
      return describe("list", ref, null);
    }
    case "justwatch":
      return describe("list", "Shared list", null);
    case "senscritique": {
      if (parts[0] === "users") {
        return describe(
          "watchlist",
          parts[1],
          `https://www.senscritique.com/${parts[1]}/collection?action=WISH`,
          `${parts[1]}'s wishlist`,
        );
      }
      return describe("list", parts[1] ?? ref, null);
    }
    default:
      return describe("list", ref, null);
  }
}

const ADDON_KEY_IN_TEXT =
  /(?:^|[/\s])(sl_[0-9A-Za-z]{22}|ur\d{4,})(?=\/manifest\.json|\/configure|$|\s)/;

/**
 * Find the Account key in a pasted Addon URL (https or stremio://), a
 * configure URL, or a bare key. Returns null for anything else.
 */
export function extractAccountKey(input: string): string | null {
  const trimmed = input.trim();
  if (/^(sl_[0-9A-Za-z]{22}|ur\d{4,})$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.replace(/^stremio:\/\//, "https://"));
    const account =
      url.searchParams.get("account") ?? url.searchParams.get("userId");
    if (account && /^(sl_[0-9A-Za-z]{22}|ur\d{4,})$/.test(account)) {
      return account;
    }
  } catch {
    // Not a URL: fall back to the pattern search below.
  }
  return ADDON_KEY_IN_TEXT.exec(trimmed)?.[1] ?? null;
}

/** The Addon URL and its install links for an Account key. */
export function buildAddonUrls(accountKey: string) {
  const addonUrl = new URL(
    `${import.meta.env.VITE_BACKEND_URL}/${accountKey}/manifest.json`,
    window.location.origin,
  ).href;
  const webUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonUrl)}`;
  const stremioUrl = `stremio://${addonUrl.replace(/^https?:\/\//, "")}`;
  return { addonUrl, webUrl, stremioUrl };
}
