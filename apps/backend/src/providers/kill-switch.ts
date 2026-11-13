import type { ProviderId } from "@stremlist/shared/providers";

/**
 * Kill switch: `DISABLED_PROVIDERS=trakt,justwatch` turns Providers off
 * without a deploy. Their Lists keep serving the last cached Catalog, and no
 * request goes to their API: no Source list read, no ID resolution, no
 * Connection, no Action.
 */
export function isProviderEnabled(id: ProviderId): boolean {
  const disabled = (process.env.DISABLED_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return !disabled.includes(id);
}
