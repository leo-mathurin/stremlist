import { SITE } from "../content/site";
import { ACCOUNT_KEY_PATTERN } from "@stremlist/shared/constants";
import {
  PROVIDERS,
  SOURCE_KIND_LABELS,
  describeSourceRef,
  sourceTitle,
} from "@stremlist/shared/providers";
import type { ParsedSourceLink, ProviderId } from "@stremlist/shared/providers";
import { sourcePageUrl } from "@stremlist/shared/source-pages";
import { stremioDeepLink } from "./stremio-links";

/** Reorders Stremio addons, so Stremlist can sit just after Cinemeta. */
export const ADDON_MANAGER_URL = SITE.addonManager;

/**
 * Official Provider marks (files in public/providers). Brand rules: show
 * them unaltered (no recolor, no opacity), only to say Stremlist works with
 * the Provider. `backdrop` fills transparent marks with a theme color.
 */
export const PROVIDER_LOGOS: Record<
  ProviderId,
  { src: string; backdrop?: "bg-justwatch" }
> = {
  imdb: { src: "/providers/imdb.svg" },
  trakt: { src: "/providers/trakt.svg" },
  simkl: { src: "/providers/simkl.png" },
  mdblist: { src: "/providers/mdblist.png" },

  justwatch: { src: "/providers/justwatch.png", backdrop: "bg-justwatch" },
  senscritique: { src: "/providers/senscritique.png" },
  letterboxd: { src: "/providers/letterboxd.svg" },
};

/** The prompt of every link field. */
export const PASTE_LINK_PROMPT = "Paste a link to a watchlist or list";

/** The live hint under a link field, such as "Trakt watchlist detected". */
export function detectedLinkHint(parsed: ParsedSourceLink) {
  const info = PROVIDERS[parsed.provider];
  if (info.availability !== "available") return `${info.label}: coming soon`;
  return `${info.label} ${SOURCE_KIND_LABELS[parsed.kind].toLowerCase()} detected`;
}

interface SourceDescription {
  kindLabel: string;
  detail: string | null;
  url: string | null;
  suggestedTitle: string;
}

/**
 * Describe a stored Source list reference for the configure page. The
 * reference formats are the ones in `@stremlist/shared/providers`.
 * `username` is the Connection's username, for the pages of a user, as in
 * Quick add.
 */
export function describeSource(
  provider: ProviderId,
  ref: string,
  username?: string | null,
) {
  const { kind, detail } = describeSourceRef(provider, ref);
  return {
    kindLabel: SOURCE_KIND_LABELS[kind],
    detail,
    url: sourcePageUrl(provider, ref, username) ?? null,
    suggestedTitle: sourceTitle(provider, ref),
  } satisfies SourceDescription;
}

function keyInPath(url: URL) {
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

function toUrl(input: string) {
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
export function extractAccountKey(input: string) {
  const trimmed = input.trim();
  if (ACCOUNT_KEY_PATTERN.test(trimmed)) return trimmed;
  const url = toUrl(trimmed);
  if (!url || !trimmed.includes("/")) return null;
  const param =
    url.searchParams.get("account") ?? url.searchParams.get("userId");
  if (param && ACCOUNT_KEY_PATTERN.test(param)) return param;
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
