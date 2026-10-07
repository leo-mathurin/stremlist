import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ProviderBackend {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start a separate backend on an OS-assigned loopback port, with a test-only
 * preload that replaces the outbound Provider transport. Only the variables
 * in `env` (and PATH) reach the process: no `.env` file is read.
 */
export async function startProviderBackend(
  preload: string,
  env: Record<string, string>,
): Promise<ProviderBackend> {
  const child: ChildProcess = spawn(
    "bun",
    [
      "--no-env-file",
      "--preload",
      fileURLToPath(new URL(preload, import.meta.url)),
      "src/dev.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../backend/", import.meta.url)),
      env: {
        PATH: process.env.PATH ?? "",
        PORT: "0",
        HOST: "127.0.0.1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Provider test backend did not start")),
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
      reject(new Error(`Provider backend exited (${code})`));
    });
    // Drain diagnostics without exposing headers, API keys or request contents.
    child.stderr?.resume();
  });
  // Keep reading stdout so the pipe never fills up.
  child.stdout?.resume();

  const stop = async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      const deadline = setTimeout(() => {
        child.unref();
        reject(new Error("Provider backend did not exit after SIGKILL"));
      }, 6_000);
      child.once("exit", () => {
        clearTimeout(force);
        clearTimeout(deadline);
        resolve();
      });
      child.kill("SIGTERM");
    });
  };
  return { url, stop };
}
