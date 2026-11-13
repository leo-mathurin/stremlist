import type { ProviderId, SourceKind } from "./providers";
import { describeSourceRef, PROVIDERS } from "./providers";

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

export function sourceNoun(kind: SourceKind): SourceNoun {
  return kind === "watchlist" ? "watchlist" : "list";
}

/** The noun for a stored Source list, from its kind. */
export function storedSourceNoun(
  provider: ProviderId,
  ref: string,
): SourceNoun {
  return sourceNoun(describeSourceRef(provider, ref).kind);
}

interface SourceProblemCopy {
  /** The problem, in a few words, without a final period. */
  title: string;
  /** What the user can do about it. */
  fix: string;
}

/**
 * Why Letterboxd cannot find a Source list (HTTP 404), by the kind of its
 * reference: a member page (watchlist, diary, films) has a wrong username,
 * a list can also be private, and a share link can be turned off.
 */
function letterboxdNotFound(ref: string): SourceProblemCopy {
  if (/^(?:share|lbxshare)\//.test(ref))
    return {
      title: "This Letterboxd share link no longer works",
      fix: "Its owner turned off sharing or deleted the list. Ask them for a new share link.",
    };
  const member =
    /^users\/[^/]+\/(watchlist|diary|films|likes\/films)(?:\/|$)/.exec(
      ref,
    )?.[1];
  if (member)
    return {
      title: `Letterboxd could not find ${
        member === "watchlist"
          ? "this watchlist"
          : member === "diary"
            ? "this diary"
            : "these films"
      }`,
      fix: "Check the username in the link.",
    };
  return {
    title: "Letterboxd could not find this list",
    fix: ref.startsWith("lbxshort/")
      ? "Check the link."
      : "Check the link. For a private list, set it to Anyone with share link on Letterboxd and paste the share link.",
  };
}

/**
 * The one wording of each problem, shared by the catalog card in Stremio and
 * the configure page. With the Source list's reference, the copy can fit its
 * kind (a Letterboxd watchlist, diary or share link).
 */
export function sourceProblemCopy(
  provider: ProviderId,
  reason: SourceProblemReason,
  noun: SourceNoun,
  sourceRef?: string,
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
        case "letterboxd":
        case "mdblist":
        case "senscritique":
        case "simkl":
          return {
            title: `This ${label} ${noun} is private`,
            fix: `Make it public on ${label}.`,
          };
      }
    case "not_found":
      if (provider === "letterboxd") return letterboxdNotFound(sourceRef ?? "");
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
        fix: `Stremlist cannot read ${label} lists yet.`,
      };
    case "unavailable":
      return {
        title: `${label} did not answer`,
        fix: "Please try again in a moment.",
      };
  }
}
