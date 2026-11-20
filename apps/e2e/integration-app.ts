import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  BACKEND_PORT,
  BACKEND_URL,
  CONNECTION_ENCRYPTION_KEY,
  FRONTEND_PORT,
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  REFRESH_COOLDOWN_SECONDS,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./env.js";

const backend = spawn(
  "bun",
  [
    "--no-env-file",
    fileURLToPath(new URL("../backend/src/dev.ts", import.meta.url)),
  ],
  {
    cwd: new URL("../backend/", import.meta.url),
    stdio: "inherit",
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(BACKEND_PORT),
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      FRONTEND_URL,
      REFRESH_COOLDOWN_SECONDS: String(REFRESH_COOLDOWN_SECONDS),
      R2_ENDPOINT,
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      R2_BUCKET,
      CONNECTION_ENCRYPTION_KEY,
      RESEND_API_KEY: "re_e2e_dummy_key",
    },
  },
);

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
backend.once("exit", (code) => {
  if (shutdown.signal.aborted) return;
  console.error(`Integration backend exited (${code})`);
  process.exitCode = 1;
  shutdown.abort();
});

async function waitForBackend() {
  while (!shutdown.signal.aborted) {
    const response = await fetch(`${BACKEND_URL}/health`, {
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(1_000)]),
    }).catch(() => undefined);
    if (response?.ok) return;
    await delay(100, undefined, { signal: shutdown.signal });
  }
  shutdown.signal.throwIfAborted();
}

try {
  await waitForBackend();
  const frontend = spawn(
    "bun",
    [
      "--no-env-file",
      "run",
      "dev:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(FRONTEND_PORT),
      "--strictPort",
    ],
    {
      cwd: new URL("../frontend/", import.meta.url),
      stdio: "inherit",
      env: { ...process.env, VITE_BACKEND_URL: BACKEND_URL },
    },
  );
  const stop = () => frontend.kill("SIGTERM");
  shutdown.signal.addEventListener("abort", stop, { once: true });
  try {
    await once(frontend, "exit");
    if (!shutdown.signal.aborted) process.exitCode = 1;
  } finally {
    shutdown.signal.removeEventListener("abort", stop);
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  shutdown.abort();
  if (backend.exitCode === null && backend.signalCode === null) {
    backend.kill("SIGTERM");
    await once(backend, "exit");
  }
}
