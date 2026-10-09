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

/**
 * - "required": the saved setup changed what Stremio read at install time.
 * - "after-save": unsaved edits will need a reinstall once saved.
 * - "none": Stremio is up to date, or the edits apply without a reinstall.
 */
export type ReinstallState = "none" | "after-save" | "required";

export function reinstallState(
  installed: InstallBaseline,
  saved: InstallBaseline,
  current: { signature: string; actionsLive: boolean },
): ReinstallState {
  if (
    saved.signature !== null &&
    saved.actionsLive !== null &&
    requiresReinstall(installed, {
      signature: saved.signature,
      actionsLive: saved.actionsLive,
    })
  ) {
    return "required";
  }
  return requiresReinstall(installed, current) &&
    requiresReinstall(saved, current)
    ? "after-save"
    : "none";
}
