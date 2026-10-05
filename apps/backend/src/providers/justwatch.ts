import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

// Placeholder until the JustWatch adapter lands.
export const justwatchProvider: ProviderAdapter = {
  id: "justwatch",
  freshnessMs: 30 * 60_000,
  validateSource() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  },
  fetchSource() {
    return Promise.reject(
      new SourceUnavailableError("unavailable", "JustWatch is not available yet"),
    );
  },
};
