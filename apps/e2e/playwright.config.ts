import { defineConfig, devices } from "@playwright/test";
import {
  BACKEND_PORT,
  BACKEND_URL,
  FRONTEND_PORT,
  FRONTEND_URL,
  REFRESH_COOLDOWN_SECONDS,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./env.js";

export default defineConfig({
  testDir: "./tests",
  // Every project shares one backend and database, so tests run serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // stremio-web registers a service worker; blocking it keeps network
    // behavior deterministic across fresh contexts.
    serviceWorkers: "block",
    launchOptions: {
      args: [
        // Chrome blocks fetches from public HTTPS pages (web.stremio.com) to
        // loopback addresses behind the Local Network Access permission, which
        // headless runs can never grant. Older Chromium versions gate the same
        // thing behind Private Network Access preflights. Disable both so the
        // hosted Stremio Web app can talk to the local addon under test.
        "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
      ],
    },
  },
  projects: [
    {
      name: "local",
      grep: /@local/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "live-smoke",
      grep: /@live-smoke/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "live-regression",
      grep: /@live-regression/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm exec tsx src/dev.ts",
      cwd: "../backend",
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(BACKEND_PORT),
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        FRONTEND_URL,
        REFRESH_COOLDOWN_SECONDS: String(REFRESH_COOLDOWN_SECONDS),
        // The Resend SDK throws at import time without a key. Newsletter
        // delivery is deliberately out of E2E scope (it would email real
        // people), so a dummy key is enough to boot the app.
        RESEND_API_KEY: "re_e2e_dummy_key",
      },
    },
    {
      command: `pnpm exec vite --port ${FRONTEND_PORT} --strictPort`,
      cwd: "../frontend",
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_BACKEND_URL: BACKEND_URL,
      },
    },
  ],
});
