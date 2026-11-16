import { joinProviderLabels, PROVIDER_IDS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";

/** What the outage banner reads of a Provider's status. */
interface OutageStatus {
  enabled: boolean;
  outageSince: string | null;
}

/**
 * The Providers with an outage, in Provider order. A Provider that is
 * unavailable is left out: its own label already says so.
 */
export function outageProviders(
  status: Record<ProviderId, OutageStatus>,
): ProviderId[] {
  return PROVIDER_IDS.filter(
    (id) => status[id].enabled && status[id].outageSince !== null,
  );
}

/**
 * The Providers that were down before and now work: on, and without an
 * outage. A Provider that became unavailable has not recovered.
 */
export function recoveredProviders(
  before: readonly ProviderId[],
  status: Record<ProviderId, OutageStatus>,
): ProviderId[] {
  return before.filter(
    (id) => status[id].enabled && status[id].outageSince === null,
  );
}

/** The outage banner's words for these Providers (at least one). */
export function outageCopy(ids: readonly ProviderId[]) {
  const one = ids.length === 1;
  return {
    title: `${joinProviderLabels(ids)} ${one ? "is" : "are"} having problems`,
    body: one
      ? "Stremlist cannot reach it right now. Lists from this service keep their last catalog in Stremio and update when it is back. You do not need to change anything."
      : "Stremlist cannot reach them right now. Lists from these services keep their last catalog in Stremio and update when they are back. You do not need to change anything.",
  };
}

/** The note after an outage ends. */
export function recoveredCopy(ids: readonly ProviderId[]): string {
  return `${joinProviderLabels(ids)} ${ids.length === 1 ? "is" : "are"} working again.`;
}

/** The start of the oldest outage, or null. */
export function earliestOutage(
  ids: readonly ProviderId[],
  status: Record<ProviderId, OutageStatus>,
): string | null {
  let earliest: string | null = null;
  for (const id of ids) {
    const since = status[id].outageSince;
    if (since && (!earliest || Date.parse(since) < Date.parse(earliest)))
      earliest = since;
  }
  return earliest;
}
