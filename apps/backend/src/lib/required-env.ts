/**
 * Variables without which the backend cannot serve Lists or Connections.
 * `index.ts` imports this module first, so a missing one stops the start
 * instead of failing later, inside a request. On Vercel, the release smoke
 * test then fails on `/health` and the deployment is not promoted.
 */
const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "CONNECTION_ENCRYPTION_KEY",
] as const;

export function missingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = REQUIRED.filter((name) => !env[name]?.trim());
  // A local S3-compatible store (R2_ENDPOINT) replaces the R2 account.
  if (!env.R2_ENDPOINT?.trim() && !env.R2_ACCOUNT_ID?.trim()) {
    missing.push("R2_ACCOUNT_ID");
  }
  return missing;
}

export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env) {
  const missing = missingEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. ` +
        `See "Backend Environment Variables" in README.md.`,
    );
  }
}

assertRequiredEnv();
