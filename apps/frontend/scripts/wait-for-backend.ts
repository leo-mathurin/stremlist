import type { Plugin } from "vite";

const RETRY_MS = 500;

async function backendIsUp(target: string): Promise<boolean> {
  try {
    const response = await fetch(`${target}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Hold the dev server until the backend behind the `/api` proxy answers
 * `/health`. Vite awaits `configureServer` before it listens, so the page
 * never loads with a backend that is still starting (`dev:local` starts
 * Supabase first).
 */
export function waitForBackend(target: string): Plugin {
  return {
    name: "stremlist:wait-for-backend",
    apply: "serve",
    async configureServer(server) {
      if (await backendIsUp(target)) return;
      const { logger } = server.config;
      logger.info(
        `Waiting for the backend at ${target} (start it, or set VITE_BACKEND_URL to skip the dev proxy)…`,
      );
      while (!(await backendIsUp(target))) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
      logger.info("Backend is up.");
    },
  };
}
