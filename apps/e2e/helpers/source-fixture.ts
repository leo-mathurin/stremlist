import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ProviderBackend } from "./provider-backend.js";
import { startProviderBackend } from "./provider-backend.js";

/**
 * Source lists that the isolated backend reads instead of the real
 * Providers (see `source-transport.ts`). The test rewrites it between
 * refreshes to simulate consecutive synchronizations.
 */
export interface SourceFixture {
  /** IMDb watchlists by `ur…` ID: the IMDb IDs, oldest added first. */
  imdb: Record<string, { ids: string[]; fail?: boolean }>;
  /** Public Trakt watchlists by user. An item without `imdb` stays unresolved. */
  trakt: Record<
    string,
    {
      items: { trakt: number; imdb?: string; name: string; year: number }[];
      fail?: boolean;
    }
  >;
  /** IMDb metadata of every Title the fixture uses. */
  titles: Record<
    string,
    { name: string; year: number; type: "movie" | "series" }
  >;
}

export interface SourceFixtureBackend extends ProviderBackend {
  write(state: SourceFixture): void;
}

/**
 * Start the normal backend on an OS-assigned port, against the E2E database
 * and R2 store, with the Provider transport replaced by the fixture.
 */
export async function startSourceFixtureBackend(
  initial: SourceFixture,
): Promise<SourceFixtureBackend> {
  const dir = mkdtempSync(join(tmpdir(), "stremlist-sources-"));
  const file = join(dir, "sources.json");
  const write = (state: SourceFixture) =>
    writeFileSync(file, JSON.stringify(state));
  write(initial);

  const backend = await startProviderBackend("./source-transport.ts", {
    E2E_SOURCE_FIXTURE_FILE: file,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FRONTEND_URL,
    REFRESH_COOLDOWN_SECONDS: String(REFRESH_COOLDOWN_SECONDS),
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    CONNECTION_ENCRYPTION_KEY,
    // Public Trakt reads need a client ID header; the fixture ignores it.
    TRAKT_CLIENT_ID: "fixture-only",
    RESEND_API_KEY: "re_e2e_dummy_key",
  });
  return {
    url: backend.url,
    write,
    async stop() {
      try {
        await backend.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
