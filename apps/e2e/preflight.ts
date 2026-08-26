import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "./env.js";
import { ensureR2Bucket } from "./helpers/r2.js";

// This script runs before Playwright starts its web servers, so database
// failures surface immediately instead of becoming a backend startup timeout.
try {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/users?select=imdb_user_id&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Supabase responded ${response.status}: ${await response.text()}`,
    );
  }
} catch (error) {
  throw new Error(
    `E2E Supabase stack is not reachable at ${SUPABASE_URL}.\n` +
      `Start the local stack from the repository root with:\n` +
      `  supabase start -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta\n` +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

let r2Error: unknown;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    await ensureR2Bucket();
    r2Error = undefined;
    break;
  } catch (error) {
    r2Error = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

if (r2Error) {
  throw new Error(
    `The E2E R2-compatible store is not reachable.\n` +
      `Start MinIO from the repository root with the command documented in apps/e2e/README.md.\n` +
      `Underlying error: ${r2Error instanceof Error ? r2Error.message : String(r2Error)}`,
  );
}
