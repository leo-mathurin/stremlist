import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderEnabled } from "./kill-switch";
import { isLetterboxdHalted, letterboxdGateStatus } from "./letterboxd-gate";

/**
 * Whether Stremlist currently reads this Provider (its Availability). A
 * Provider is unavailable when an operator turns it off with the kill switch,
 * or when it refuses Stremlist's reads (Letterboxd's automatic halt). The user
 * sees one label for both; the cause stays in the logs and the alerts.
 */
export async function isProviderAvailable(id: ProviderId): Promise<boolean> {
  if (!isProviderEnabled(id)) return false;
  if (id === "letterboxd") return !(await isLetterboxdHalted());
  return true;
}

/**
 * A reason to alert although the Provider is available, or null. Letterboxd
 * is degraded when 429 responses kept its rate below half of
 * LETTERBOXD_MAX_RPS for 30 minutes: users wait longer than planned.
 */
export async function providerDegradation(
  id: ProviderId,
): Promise<string | null> {
  if (id !== "letterboxd") return null;
  try {
    const status = await letterboxdGateStatus();
    return status.slow_ms >= 30 * 60_000
      ? `letterboxd has run at ${status.rate} requests/s, below half of LETTERBOXD_MAX_RPS, for 30 minutes`
      : null;
  } catch {
    return null;
  }
}
