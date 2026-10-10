import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  CONNECTION_ENCRYPTION_KEY,
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  REFRESH_COOLDOWN_SECONDS,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../env.js";
import type { Api } from "./api.js";
import { apiAt } from "./api.js";
import { startProviderBackend } from "./provider-backend.js";

/** One outbound Provider request, as the preload logged it. */
interface LoggedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

export interface FixtureBackend {
  url: string;
  /** The API readers and writers of this backend. */
  api: Api;
  /** The Provider requests since the last `clearRequests()` that `match`. */
  requests: (match?: (url: URL) => boolean) => LoggedRequest[];
  clearRequests: () => void;
  /**
   * Connect `provider` the way a user does: start the authorization, then
   * come back to the OAuth callback with the fixture code (the fixtures
   * exchange `fixture-code` for the token `fresh-access`).
   */
  authorize: (
    accountKey: string,
    provider: ProviderId,
  ) => Promise<{
    authorizeUrl: URL;
    callback: { status: number; location: string | null };
  }>;
  stop: () => Promise<void>;
}

/**
 * Start a backend on a free loopback port with the fetch fixture `preload`
 * (relative to `helpers/`). It uses the local Supabase and RustFS stack of the
 * Playwright backend and dummy Provider client IDs. `extraEnv` adds or
 * overrides variables. The preload logs each Provider request to a temporary
 * file that `requests()` reads.
 */
export async function startFixtureBackend(
  preload: string,
  extraEnv: Record<string, string> = {},
): Promise<FixtureBackend> {
  const logDir = mkdtempSync(join(tmpdir(), "stremlist-provider-log-"));
  const logFile = join(logDir, "requests.jsonl");
  writeFileSync(logFile, "");
  const child = await startProviderBackend(preload, {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FRONTEND_URL,
    REFRESH_COOLDOWN_SECONDS: String(REFRESH_COOLDOWN_SECONDS),
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    CONNECTION_ENCRYPTION_KEY,
    // The Resend SDK throws at import time without a key; no mail is sent.
    RESEND_API_KEY: "re_e2e_dummy_key",
    // Dummy OAuth apps: helpers/provider-fixtures.ts expects these client IDs.
    // No TMDB key, so the ID resolver uses Wikidata only.
    TRAKT_CLIENT_ID: "fixture-trakt-client",
    SIMKL_CLIENT_ID: "fixture-simkl-client",
    MDBLIST_CLIENT_ID: "fixture-mdblist-client",
    E2E_PROVIDER_LOG: logFile,
    ...extraEnv,
  }).catch((error: unknown) => {
    rmSync(logDir, { recursive: true, force: true });
    throw error;
  });
  const api = apiAt(child.url);

  return {
    url: child.url,
    api,
    requests: (match = () => true) =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LoggedRequest)
        .filter((entry) => match(new URL(entry.url))),
    clearRequests: () => writeFileSync(logFile, ""),
    async authorize(accountKey, provider) {
      const start = await api.startConnection(accountKey, provider);
      if (start.status !== 200) {
        throw new Error(`Connect ${provider} answered ${start.status}`);
      }
      const authorizeUrl = new URL(start.body.authorizeUrl);
      const callback = await api.oauthCallback(provider, {
        code: "fixture-code",
        state: authorizeUrl.searchParams.get("state") ?? "",
      });
      return { authorizeUrl, callback };
    },
    async stop() {
      try {
        await child.stop();
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    },
  };
}
