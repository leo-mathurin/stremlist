// Shared constants for the E2E harness. Every port is distinct from the
// regular dev ports (7001/5173) so tests can run next to a dev session.

export const BACKEND_PORT = 7301;
export const FRONTEND_PORT = 7302;

export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

export const STREMIO_WEB_URL = "https://web.stremio.com";

// Local Supabase stack (supabase start). The service-role key below is the
// public, well-known key every local Supabase CLI stack ships with — it is not
// a secret. Both values can be overridden for non-default stacks.
export const SUPABASE_URL =
  process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const SUPABASE_SERVICE_ROLE_KEY =
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// MinIO is used as the local S3-compatible R2 test double. These credentials
// belong only to the disposable E2E container and may be overridden in CI.
export const R2_ENDPOINT =
  process.env.E2E_R2_ENDPOINT ?? "http://127.0.0.1:7431";
export const R2_ACCESS_KEY_ID =
  process.env.E2E_R2_ACCESS_KEY_ID ?? "stremlist-e2e";
export const R2_SECRET_ACCESS_KEY =
  process.env.E2E_R2_SECRET_ACCESS_KEY ?? "stremlist-e2e-secret";
export const R2_BUCKET = process.env.E2E_R2_BUCKET ?? "stremlist-e2e-cache";

const REMOTE_DATABASE_CONFIRMATION = "I_UNDERSTAND_THIS_WIPES_DATA";

function assertSafeSupabaseTarget(): void {
  let hostname: string;
  try {
    hostname = new URL(SUPABASE_URL).hostname.toLowerCase();
  } catch {
    throw new Error(`E2E_SUPABASE_URL is not a valid URL: ${SUPABASE_URL}`);
  }

  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    hostname,
  );
  const remoteWipeConfirmed =
    process.env.E2E_ALLOW_REMOTE_DATABASE === REMOTE_DATABASE_CONFIRMATION;

  if (!isLoopback && !remoteWipeConfirmed) {
    throw new Error(
      `Refusing to run destructive E2E cleanup against non-loopback Supabase host "${hostname}". ` +
        `Use a disposable local stack, or set E2E_ALLOW_REMOTE_DATABASE=${REMOTE_DATABASE_CONFIRMATION} only for an isolated remote test project.`,
    );
  }
}

assertSafeSupabaseTarget();

// Short cooldown so refresh-throttle tests stay fast.
export const REFRESH_COOLDOWN_SECONDS = 2;

export function addonManifestUrl(userId: string): string {
  return `${BACKEND_URL}/${userId}/manifest.json`;
}
