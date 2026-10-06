import type { ProviderId, SourceKind } from "./providers";
import { PROVIDERS } from "./providers";

/**
 * Why a Source list cannot be read. Every reason except "unavailable" is an
 * expected state: the catalog shows a card and the configure page explains
 * it, instead of a server error.
 */
export const SOURCE_PROBLEM_REASONS = [
  "private",
  "not_found",
  "needs_connection",
  "disabled",
  "coming_soon",
  "premium_only",
  "unavailable",
] as const;

export type SourceProblemReason = (typeof SOURCE_PROBLEM_REASONS)[number];

/** What to call a Source list in user-facing copy. */
export type SourceNoun = "watchlist" | "list";

export function sourceNoun(kind: SourceKind | null | undefined): SourceNoun {
  return kind === "watchlist" ? "watchlist" : "list";
}

/**
 * The noun for a stored Source list. IMDb watchlists are `ur…` IDs; other
 * Providers name their watchlist ref `…watchlist` (or `plantowatch` on Simkl).
 */
export function storedSourceNoun(
  provider: ProviderId,
  ref: string,
): SourceNoun {
  if (provider === "imdb") return ref.startsWith("ur") ? "watchlist" : "list";
  return /(?:^|\/)(?:watchlist|plantowatch)$/.test(ref) ? "watchlist" : "list";
}

export interface SourceProblemCopy {
  /** The problem, in a few words, without a final period. */
  title: string;
  /** What the user can do about it. */
  fix: string;
}

/**
 * The one wording of each problem, shared by the catalog card in Stremio and
 * the configure page.
 */
export function sourceProblemCopy(
  provider: ProviderId,
  reason: SourceProblemReason,
  noun: SourceNoun = "list",
): SourceProblemCopy {
  const label = PROVIDERS[provider].label;
  switch (reason) {
    case "private":
      switch (provider) {
        case "imdb":
          return {
            title: `This IMDb ${noun} is private`,
            fix: `Make your ${noun} public in your IMDb account settings.`,
          };
        case "trakt":
          return {
            title: `This Trakt ${noun} is private`,
            fix: "Set its privacy to Public on Trakt, or connect Trakt to read your private lists.",
          };
        case "justwatch":
          return {
            title: "This JustWatch list is not shared",
            fix: "In JustWatch, open the list and choose Share to get its link.",
          };
        default:
          return {
            title: `This ${label} ${noun} is private`,
            fix: `Make it public on ${label}.`,
          };
      }
    case "not_found":
      return {
        title: `${label} could not find this ${noun}`,
        fix: "Check the link. The list may have been deleted.",
      };
    case "needs_connection":
      return {
        title: `This ${noun} needs your ${label} account`,
        fix: `Connect ${label} on the Stremlist configure page.`,
      };
    case "disabled":
      return {
        title: `${label} is temporarily unavailable`,
        fix: "Please try again later.",
      };
    case "premium_only":
      return {
        title: `This ${noun} needs a paid ${label} plan`,
        fix: `${label} only shares it with paid accounts.`,
      };
    case "coming_soon":
      return {
        title: `${label} is coming soon`,
        fix:
          provider === "letterboxd"
            ? "Tip: import it into MDBList, then add the MDBList list."
            : `Stremlist cannot read ${label} lists yet.`,
      };
    case "unavailable":
      return {
        title: `${label} did not answer`,
        fix: "Please try again in a moment.",
      };
  }
}
