import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

// Placeholder until the Trakt adapter lands.
export const traktProvider: ProviderAdapter = {
  id: "trakt",
  freshnessMs: 30 * 60_000,
  validateSource() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  },
  fetchSource() {
    return Promise.reject(
      new SourceUnavailableError("unavailable", "Trakt is not available yet"),
    );
  },
};
