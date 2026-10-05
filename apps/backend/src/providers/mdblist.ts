import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

// Placeholder until the MDBList adapter lands.
export const mdblistProvider: ProviderAdapter = {
  id: "mdblist",
  freshnessMs: 30 * 60_000,
  validateSource() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  },
  fetchSource() {
    return Promise.reject(
      new SourceUnavailableError("unavailable", "MDBList is not available yet"),
    );
  },
};
