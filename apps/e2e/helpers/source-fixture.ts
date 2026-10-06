import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONNECTION_ENCRYPTION_KEY,
  FRONTEND_URL,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  REFRESH_COOLDOWN_SECONDS,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../env.js";

/**
 * Source lists that the isolated backend reads instead of the real
 * Providers (see `source-transport.ts`). The test rewrites it between
 * refreshes to simulate consecutive synchronizations.
 */
export interface SourceFixture {
  /** IMDb watchlists by `ur…` ID: the IMDb IDs, oldest added first. */
  imdb: Record<string, { ids: string[]; fail?: boolean }>;
  /** Public Trakt watchlists by user. An item without `imdb` stays unresolved. */
  trakt: Record<
    string,
    {
      items: { trakt: number; imdb?: string; name: string; year: number }[];
      fail?: boolean;
    }
  >;
  /** IMDb metadata of every Title the fixture uses. */
  titles: Record<
    string,
    { name: string; year: number; type: "movie" | "series" }
  >;
}

export interface SourceFixtureBackend {
  url: string;
  write(state: SourceFixture): void;
  stop(): Promise<void>;
}

/**
 * Start the normal backend on an OS-assigned port, against the E2E database
 * and R2 store, with the Provider transport replaced by the fixture.
 */
export async function startSourceFixtureBackend(
  initial: SourceFixture,
): Promise<SourceFixtureBackend> {
  const dir = mkdtempSync(join(tmpdir(), "stremlist-sources-"));
  const file = join(dir, "sources.json");
  const write = (state: SourceFixture) =>
    writeFileSync(file, JSON.stringify(state));
  write(initial);

  const child: ChildProcess = spawn(
    "bun",
    [
      "--no-env-file",
      "--preload",
      fileURLToPath(new URL("./source-transport.ts", import.meta.url)),
      "src/dev.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../backend/", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        PORT: "0",
        HOST: "127.0.0.1",
        E2E_SOURCE_FIXTURE_FILE: file,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        FRONTEND_URL,
        REFRESH_COOLDOWN_SECONDS: String(REFRESH_COOLDOWN_SECONDS),
        R2_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        R2_BUCKET,
        CONNECTION_ENCRYPTION_KEY,
        // Public Trakt reads need a client ID header; the fixture ignores it.
        TRAKT_CLIENT_ID: "fixture-only",
        RESEND_API_KEY: "re_e2e_dummy_key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Source fixture backend did not start")),
      20_000,
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const port = output.match(
        /backend running on http:\/\/localhost:(\d+)/,
      )?.[1];
      if (port) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Source fixture backend exited (${code})`));
    });
    child.stderr?.resume();
  });

  return {
    url,
    write,
    async stop() {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
          child.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
