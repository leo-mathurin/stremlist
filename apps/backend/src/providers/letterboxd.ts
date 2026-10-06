import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

/**
 * Letterboxd is on hold until Letterboxd answers our API access request
 * (STR-20). Links are recognized so the UI can say "coming soon".
 */
export const letterboxdProvider: ProviderAdapter = {
  id: "letterboxd",
  freshnessMs: 30 * 60_000,
  validateSource() {
    return Promise.resolve({ ok: false, reason: "coming_soon" });
  },
  fetchSource() {
    return Promise.reject(
      new SourceUnavailableError(
        "coming_soon",
        "Letterboxd is not available yet",
      ),
    );
  },
};
