import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

// Placeholder until the SensCritique adapter lands.
export const senscritiqueProvider: ProviderAdapter = {
  id: "senscritique",
  freshnessMs: 30 * 60_000,
  validateSource() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  },
  fetchSource() {
    return Promise.reject(
      new SourceUnavailableError("unavailable", "SensCritique is not available yet"),
    );
  },
};
