/**
 * What Stremio reads only at install time: the catalog signature of the
 * Lists (see `getListReinstallSignature`), whether Actions are on (their
 * `stream` resource) and whether the "New titles" catalogs are on (ADR 0007).
 */
export interface InstallState {
  signature: string;
  actionsLive: boolean;
  newTitles: boolean;
}

/**
 * The InstallState of the user's last install. Null parts are not known yet
 * (the configuration has not loaded) and never ask for a reinstall.
 */
export type InstallBaseline = {
  [Key in keyof InstallState]: InstallState[Key] | null;
};

export const UNKNOWN_INSTALL: InstallBaseline = {
  signature: null,
  actionsLive: null,
  newTitles: null,
};

/**
 * A save that changes any known part of the InstallState needs a reinstall.
 * An Account saved without Lists has a known, empty signature: its first
 * List changes it.
 */
export function requiresReinstall(
  baseline: InstallBaseline,
  current: InstallState,
): boolean {
  return (Object.keys(current) as (keyof InstallState)[]).some(
    (key) => baseline[key] !== null && baseline[key] !== current[key],
  );
}
