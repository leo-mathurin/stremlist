import type { E2EConfig } from "e2e";
import { chatgpt } from "e2e/oauth/chatgpt";
import { web } from "@e2e-dev/web";

export default {
  projectId: "stremlist-ui",
  tests: "toolkit/**/*.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  agents: {
    default: {
      model: chatgpt("gpt-6-luna"),
      maxModelCalls: 12,
      maxSteps: 18,
    },
  },
  cache: {
    dir: ".e2e/cache",
    mode: process.env.CI ? "read-only" : "read-write",
    strict: !!process.env.CI,
  },
  trace: "retain-on-failure",
  reporters: ["list", "markdown", "junit"],
  targets: [
    {
      name: "chromium",
      engine: web(),
      app: {
        url: "http://127.0.0.1:4311",
        environment: "test",
        command: {
          executable: "bun",
          args: [
            "run",
            "dev:app",
            "--host",
            "127.0.0.1",
            "--port",
            "4311",
            "--strictPort",
          ],
          cwd: "../frontend",
          env: { VITE_BACKEND_URL: "http://127.0.0.1:4314" },
        },
      },
    },
  ],
} satisfies E2EConfig;
