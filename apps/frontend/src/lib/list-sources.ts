import { SITE } from "../content/site";
import { ACCOUNT_KEY_PATTERN } from "@stremlist/shared/constants";
import {
  PROVIDERS,
  SOURCE_KIND_LABELS,
  describeSourceRef,
  sourceTitle,
} from "@stremlist/shared/providers";
import type { ParsedSourceLink, ProviderId } from "@stremlist/shared/providers";
import { stremioDeepLink } from "./stremio-links";

/** Reorders Stremio addons, so Stremlist can sit just after Cinemeta. */
export const ADDON_MANAGER_URL = SITE.addonManager;

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

/** The live hint under a link field, such as "Trakt watchlist detected". */
export function detectedLinkHint(parsed: ParsedSourceLink): string {
  const info = PROVIDERS[parsed.provider];
  if (info.availability !== "available") return `${info.label}: coming soon`;
  return `${info.label} ${SOURCE_KIND_LABELS[parsed.kind].toLowerCase()} detected`;
}

interface SourceDescription {
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
  const { kind, detail, url } = describeSourceRef(provider, ref);
  return {
    kindLabel: SOURCE_KIND_LABELS[kind],
    detail,
    url,
    suggestedTitle: sourceTitle(provider, ref),
  };
}

/** A key in the URL as an Addon URL holds it (`/<key>/manifest.json`). */
function keyInPath(url: URL): string | null {
  const segments = url.pathname.split("/");
  for (let index = 1; index < segments.length; index++) {
    const key = segments[index - 1];
    if (
      ["manifest.json", "configure"].includes(segments[index]) &&
      ACCOUNT_KEY_PATTERN.test(key)
    ) {
      return key;
    }
  }
  return null;
}

function toUrl(input: string): URL | null {
  try {
    return new URL(
      /^[a-z]+:\/\//i.test(input)
        ? input.replace(/^stremio:\/\//i, "https://")
        : `https://${input}`,
    );
  } catch {
    return null;
  }
}

/**
 * Find the Account key in a pasted Addon URL (https or stremio://), a
 * configure URL, a Stremio Web install link, or a bare key. Returns null for
 * anything else, such as an IMDb profile page: a key is only read from where
 * a Stremlist URL puts it.
 */
export function extractAccountKey(input: string): string | null {
  const trimmed = input.trim();
  if (ACCOUNT_KEY_PATTERN.test(trimmed)) return trimmed;
  const url = toUrl(trimmed);
  if (!url || !trimmed.includes("/")) return null;
  const param =
    url.searchParams.get("account") ?? url.searchParams.get("userId");
  if (param && ACCOUNT_KEY_PATTERN.test(param)) return param;
  // Stremio Web: `#/addons?addon=<Addon URL>`.
  const hashQuery = url.hash.split("?")[1];
  const addon = hashQuery && new URLSearchParams(hashQuery).get("addon");
  if (addon) {
    const inner = toUrl(addon);
    if (inner) return keyInPath(inner);
  }
  return keyInPath(url);
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

/** Opens the app, or Stremio Web when the Addon URL has no deep link. */
export function reinstallLinkProps(accountKey: string) {
  const { stremioUrl, webUrl } = buildAddonUrls(accountKey);
  return stremioUrl
    ? { href: stremioUrl }
    : { href: webUrl, target: "_blank", rel: "noopener noreferrer" };
}
