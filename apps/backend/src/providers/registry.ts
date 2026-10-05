import type { ProviderId } from "@stremlist/shared/providers";
import { imdbProvider } from "./imdb";
import { justwatchProvider } from "./justwatch";
import { letterboxdProvider } from "./letterboxd";
import { mdblistProvider } from "./mdblist";
import { senscritiqueProvider } from "./senscritique";
import { simklProvider } from "./simkl";
import { traktProvider } from "./trakt";
import type { ProviderAdapter } from "./types";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  imdb: imdbProvider,
  trakt: traktProvider,
  simkl: simklProvider,
  mdblist: mdblistProvider,
  justwatch: justwatchProvider,
  senscritique: senscritiqueProvider,
  letterboxd: letterboxdProvider,
};

export function getProvider(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}

/**
 * Kill switch: `DISABLED_PROVIDERS=trakt,justwatch` turns Providers off
 * without a deploy. Their Lists keep serving the last cached Catalog.
 */
export function isProviderEnabled(id: ProviderId): boolean {
  const disabled = (process.env.DISABLED_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return !disabled.includes(id);
}
