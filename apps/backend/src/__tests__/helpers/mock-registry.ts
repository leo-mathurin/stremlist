/**
 * Provider registry for tests: the real adapters, except the ones a test
 * replaces with a fake. Use it with
 * `vi.mock("…/providers/registry", () => import("…/helpers/mock-registry"))`.
 */
import type { ProviderId } from "@stremlist/shared/providers";
import { imdbProvider } from "../../providers/imdb";
import { justwatchProvider } from "../../providers/justwatch";
import { letterboxdProvider } from "../../providers/letterboxd";
import { mdblistProvider } from "../../providers/mdblist";
import { senscritiqueProvider } from "../../providers/senscritique";
import { simklProvider } from "../../providers/simkl";
import { traktProvider } from "../../providers/trakt";
import type {
  ProviderAdapter,
  ProviderActions,
  SourceEntry,
} from "../../providers/types";

const REAL: Record<ProviderId, ProviderAdapter> = {
  imdb: imdbProvider,
  trakt: traktProvider,
  simkl: simklProvider,
  mdblist: mdblistProvider,
  justwatch: justwatchProvider,
  senscritique: senscritiqueProvider,
  letterboxd: letterboxdProvider,
};

export const providerOverrides = new Map<ProviderId, ProviderAdapter>();

export function useFakeProvider(adapter: ProviderAdapter): ProviderAdapter {
  providerOverrides.set(adapter.id, adapter);
  return adapter;
}

export function resetProviders(): void {
  providerOverrides.clear();
  delete process.env.DISABLED_PROVIDERS;
}

export function getProvider(id: ProviderId): ProviderAdapter {
  return providerOverrides.get(id) ?? REAL[id];
}

export function isProviderEnabled(id: ProviderId): boolean {
  const disabled = (process.env.DISABLED_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return !disabled.includes(id);
}

/** A Provider adapter that serves fixed entries and accepts every ref. */
export function fakeAdapter(
  id: ProviderId,
  overrides: Partial<ProviderAdapter> & { entries?: SourceEntry[] } = {},
): ProviderAdapter {
  const { entries = [], ...rest } = overrides;
  return {
    id,
    freshnessMs: 30 * 60_000,
    validateSource: (ref) => Promise.resolve({ ok: true, ref }),
    fetchSource: () => Promise.resolve({ entries: structuredClone(entries) }),
    ...rest,
  };
}

/** Actions that record every call and never touch a network. */
export function fakeActions(
  overrides: Partial<ProviderActions> = {},
): ProviderActions {
  return {
    kinds: ["watchlist", "watched", "rating"],
    getMembership: () =>
      Promise.resolve({
        watchlist: [],
        watched: [],
        watchedEpisodes: [],
        ratings: {},
      }),
    perform: () => Promise.resolve(),
    affectedSources: (intent) =>
      intent.kind === "watchlist"
        ? ["me/watchlist"]
        : intent.kind === "watched"
          ? ["me/history", "me/up-next"]
          : [],
    ...overrides,
  };
}
