import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

// Placeholder until the Simkl adapter lands.
export const simklProvider: ProviderAdapter = {
  id: "simkl",
  freshnessMs: 30 * 60_000,
  validateSource() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  },
  fetchSource() {
    return Promise.reject(
      new SourceUnavailableError("unavailable", "Simkl is not available yet"),
    );
  },
};
