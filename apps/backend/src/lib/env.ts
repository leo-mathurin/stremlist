import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const required = z.string().trim().min(1);

/**
 * Variables without which the backend cannot serve Lists or Connections.
 * `index.ts` imports this module first, so a missing one stops the start
 * instead of failing later, inside a request. On Vercel, the release smoke
 * test then fails on `/health` and the deployment is not promoted. Tests mock
 * Supabase and R2, so Vitest skips the check.
 */
createEnv({
  server: {
    SUPABASE_URL: required.url(),
    SUPABASE_SERVICE_ROLE_KEY: required,
    R2_ACCOUNT_ID: required.optional(),
    R2_ENDPOINT: required.url().optional(),
    R2_ACCESS_KEY_ID: required,
    R2_SECRET_ACCESS_KEY: required,
    R2_BUCKET: required,
    CONNECTION_ENCRYPTION_KEY: required.refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "must be 32 bytes in base64",
    ),
  },
  runtimeEnv: process.env,
  // A local S3-compatible store (R2_ENDPOINT) replaces the R2 account.
  createFinalSchema: (shape) =>
    z.object(shape).refine((env) => env.R2_ENDPOINT ?? env.R2_ACCOUNT_ID, {
      message: "set R2_ACCOUNT_ID, or R2_ENDPOINT for a local store",
      path: ["R2_ACCOUNT_ID"],
    }),
  skipValidation: process.env.VITEST === "true",
  onValidationError: (issues) => {
    const lines = issues.map((issue) => {
      const key = issue.path?.[0];
      const name = typeof key === "object" ? key.key : key;
      return `${String(name)}: ${issue.message}`;
    });
    throw new Error(
      `Invalid environment variables. See "Backend Environment Variables" in README.md.\n  ${lines.join("\n  ")}`,
    );
  },
});
