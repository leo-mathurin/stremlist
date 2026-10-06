/**
 * What Stremio read when the user last installed: the catalog signature of
 * the Lists (see `getListReinstallSignature`) and whether Actions were on.
 * Null parts are not known yet (the configuration has not loaded).
 */
export interface InstallBaseline {
  signature: string | null;
  actionsLive: boolean | null;
  /** Whether the "New titles" catalogs were on (ADR 0007). */
  newTitles: boolean | null;
}

/**
 * Stremio reads catalogs (the Lists' and the "New titles" ones) and the
 * Actions `stream` resource only at install time, so a save that changes
 * any of them needs a reinstall. An Account saved
 * without Lists has a known, empty signature: its first List changes it.
 */
export function requiresReinstall(
  baseline: InstallBaseline,
  current: { signature: string; actionsLive: boolean; newTitles: boolean },
): boolean {
  return (
    (baseline.signature !== null && current.signature !== baseline.signature) ||
    (baseline.actionsLive !== null &&
      current.actionsLive !== baseline.actionsLive) ||
    (baseline.newTitles !== null && current.newTitles !== baseline.newTitles)
  );
}
