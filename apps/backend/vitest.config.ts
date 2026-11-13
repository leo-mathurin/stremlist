import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    // src/lib/required-env.ts stops the import of src/index.ts without these.
    // Tests mock Supabase and R2, so the values are never used.
    env: {
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      R2_ACCOUNT_ID: "test-account",
      R2_ACCESS_KEY_ID: "test-access-key",
      R2_SECRET_ACCESS_KEY: "test-secret-key",
      R2_BUCKET: "test-bucket",
      CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    },
  },
});
