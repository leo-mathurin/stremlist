import type { E2EConfig } from "e2e";
import {
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./env.js";
import { engine } from "./integration-browser.js";

export default {
  projectId: "stremlist-integration",
  tests: "test/**/*.e2e.ts",
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  actionTimeout: 20_000,
  assertionTimeout: 20_000,
  output: "test-results/integration",
  trace: "retain-on-failure",
  reporters: ["list", "markdown", "junit"],
  targets: [
    {
      name: "chromium",
      engine,
      app: {
        url: FRONTEND_URL,
        environment: "test",
        command: {
          executable: "bun",
          args: ["--no-env-file", "integration-app.ts"],
          cwd: ".",
          startupTimeout: 60_000,
          env: {
            E2E_SUPABASE_URL: SUPABASE_URL,
            E2E_SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY,
            E2E_ALLOW_REMOTE_DATABASE:
              process.env.E2E_ALLOW_REMOTE_DATABASE ?? "",
            E2E_R2_ENDPOINT: R2_ENDPOINT,
            E2E_R2_BUCKET: R2_BUCKET,
            E2E_R2_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
            E2E_R2_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
          },
        },
      },
    },
  ],
} satisfies E2EConfig;
