// Readiness probe for `turbo run dev*`: the frontend dev task depends on it,
// so the frontend starts only when the backend answers /health. It does not
// start the backend. `dev:local` starts Supabase first, which can take
// minutes on a first run (Docker images).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 10 * 60_000;

/** The backend that the backend dev task starts, not a DEV_BACKEND_URL override. */
function backendUrl() {
  if (process.env.PORTLESS === "0") return "http://localhost:7001";
  const result = spawnSync("portless", ["get", "api.stremlist"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`portless get api.stremlist failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Portless serves HTTPS with its own CA, which the system does not trust.
const portlessCa = join(
  process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless"),
  "ca.pem",
);

/**
 * Resolved on each attempt: before the backend starts the Portless proxy,
 * `portless get` falls back to port 1355, and the CA may not exist yet.
 */
function healthTarget() {
  const url = `${backendUrl().replace(/\/+$/, "")}/health`;
  const tls =
    url.startsWith("https:") && existsSync(portlessCa)
      ? { ca: readFileSync(portlessCa, "utf8") }
      : undefined;
  return { url, tls };
}

let lastUrl;
async function isUp() {
  const { url, tls } = healthTarget();
  if (url !== lastUrl) {
    console.log(`Waiting for the backend at ${url}…`);
    lastUrl = url;
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2_000),
      tls,
    });
    return response.ok;
  } catch {
    return false; // Still starting.
  }
}

const deadline = Date.now() + TIMEOUT_MS;
while (!(await isUp())) {
  if (Date.now() > deadline) {
    throw new Error(`The backend did not answer ${lastUrl} within 10 minutes.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log("Backend is up.");
