/**
 * What Stremio read when the user last installed: the catalog signature of
 * the Lists (see `getListReinstallSignature`) and whether Actions were on.
 * Null parts are not known yet (the configuration has not loaded).
 */
export interface InstallBaseline {
  signature: string | null;
  actionsLive: boolean | null;
}

/**
 * Stremio reads catalogs and the Actions `stream` resource only at install
 * time, so a save that changes either needs a reinstall. An Account saved
 * without Lists has a known, empty signature: its first List changes it.
 */
export function requiresReinstall(
  baseline: InstallBaseline,
  current: { signature: string; actionsLive: boolean },
): boolean {
  return (
    (baseline.signature !== null && current.signature !== baseline.signature) ||
    (baseline.actionsLive !== null &&
      current.actionsLive !== baseline.actionsLive)
  );
}
