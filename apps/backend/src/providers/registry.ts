import type { ProviderId } from "@stremlist/shared/providers";
import { imdbProvider } from "./imdb";
import { justwatchProvider } from "./justwatch";
import { letterboxdProvider } from "./letterboxd";
import { mdblistProvider } from "./mdblist";
import { senscritiqueProvider } from "./senscritique";
import { simklProvider } from "./simkl";
import { traktProvider } from "./trakt";
import type { ProviderAdapter } from "./types";

export { isProviderEnabled } from "./kill-switch";

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
