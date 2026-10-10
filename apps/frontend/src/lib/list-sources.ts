import {
  ACCOUNT_KEY_PATTERN,
  ACCOUNT_KEY_SOURCE,
} from "@stremlist/shared/constants";
import { PROVIDERS, describeSourceRef } from "@stremlist/shared/providers";
import type {
  ParsedSourceLink,
  ProviderId,
  SourceKind,
} from "@stremlist/shared/providers";
import { stremioDeepLink } from "./stremio-links";

/** Reorders Stremio addons, so Stremlist can sit just after Cinemeta. */
export const ADDON_MANAGER_URL = "https://stremio-addon-manager.vercel.app/";

/**
 * Official Provider marks (files in public/providers). Brand rules: show
 * them unaltered (no recolor, no opacity), only to say Stremlist works with
 * the Provider. `background` fills transparent marks.
 */
export const PROVIDER_LOGOS: Record<
  ProviderId,
  { src: string; background?: string }
> = {
  imdb: { src: "/providers/imdb.svg" },
  trakt: { src: "/providers/trakt.svg" },
  simkl: { src: "/providers/simkl.png" },
  mdblist: { src: "/providers/mdblist.png" },
  // The mark without the wordmark is a transparent 64 px icon.
  justwatch: { src: "/providers/justwatch.png", background: "#0a151f" },
  senscritique: { src: "/providers/senscritique.png" },
  letterboxd: { src: "/providers/letterboxd.svg" },
};

/** The prompt of every link field. */
export const PASTE_LINK_PROMPT = "Paste a link to a watchlist or list";

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

/**
 * Describe a stored Source list reference for the configure page. The
 * reference formats are the ones in `@stremlist/shared/providers`.
 */
export function describeSource(
  provider: ProviderId,
  ref: string,
): SourceDescription {
  const { kind, detail, url, title } = describeSourceRef(provider, ref);
  return {
    kind,
    kindLabel: KIND_LABELS[kind],
    detail,
    url,
    suggestedTitle:
      title ?? `${PROVIDERS[provider].label} ${KIND_LABELS[kind]}`,
  };
}

const ADDON_KEY_IN_TEXT = new RegExp(
  String.raw`(?:^|[/\s])(${ACCOUNT_KEY_SOURCE})(?=/manifest\.json|/configure|$|\s)`,
);

/**
 * Find the Account key in a pasted Addon URL (https or stremio://), a
 * configure URL, or a bare key. Returns null for anything else.
 */
export function extractAccountKey(input: string): string | null {
  const trimmed = input.trim();
  if (ACCOUNT_KEY_PATTERN.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.replace(/^stremio:\/\//, "https://"));
    const account =
      url.searchParams.get("account") ?? url.searchParams.get("userId");
    if (account && ACCOUNT_KEY_PATTERN.test(account)) {
      return account;
    }
  } catch {
    // Not a URL: fall back to the pattern search below.
  }
  return ADDON_KEY_IN_TEXT.exec(trimmed)?.[1] ?? null;
}

/**
 * The Addon URL and its install links for an Account key. `stremioUrl` is
 * null when Stremio cannot open the Addon URL from a deep link (local dev).
 */
export function buildAddonUrls(accountKey: string) {
  const addonUrl = new URL(
    `${import.meta.env.VITE_BACKEND_URL}/${accountKey}/manifest.json`,
    window.location.origin,
  ).href;
  const webUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonUrl)}`;
  const stremioUrl = stremioDeepLink(addonUrl);
  return { addonUrl, webUrl, stremioUrl };
}
