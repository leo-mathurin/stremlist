import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderEnabled } from "./kill-switch";
import { isLetterboxdHalted } from "./letterboxd-cache";

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
