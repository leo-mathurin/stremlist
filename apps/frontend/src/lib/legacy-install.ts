import { LEGACY_ALIAS_PATTERN } from "@stremlist/shared/constants";
import type { ParsedSourceLink } from "@stremlist/shared/providers";

export interface LegacyInstallLookup {
  /**
   * Whether an install answers to this Legacy alias: the public configure
   * page reads the same answer. Throws when the check itself fails.
   */
  exists: (alias: string) => Promise<boolean>;
  /** The canonical IMDb user ID of a pasted `p.` handle link, if any. */
  canonicalRef: (input: string) => Promise<string | null>;
}

/**
 * The v1 install that a link pasted on Home belongs to: v1 keyed each install
 * by the IMDb ID that the user pasted, so a returning user who pastes it again
 * means that install, not a new one. v1 stored a `p.` handle as pasted or as
 * its canonical `ur…` ID, so a handle checks both. Null when the link is not
 * an IMDb ID that an install answers to.
 */
export async function findLegacyInstall(
  input: string,
  parsed: ParsedSourceLink | null,
  lookup: LegacyInstallLookup,
): Promise<string | null> {
  if (parsed?.provider !== "imdb") return null;
  const alias = parsed.sourceRef;
  if (!LEGACY_ALIAS_PATTERN.test(alias)) return null;
  if (await lookup.exists(alias)) return alias;
  if (!alias.startsWith("p.")) return null;
  const canonical = await lookup.canonicalRef(input);
  if (!canonical || canonical === alias) return null;
  if (!LEGACY_ALIAS_PATTERN.test(canonical)) return null;
  return (await lookup.exists(canonical)) ? canonical : null;
}
