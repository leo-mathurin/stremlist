import { spawnSync } from "node:child_process";

export const excludedServices =
  "gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta";

// CLI container names differ from the names accepted by --exclude.
const excludedContainers = [
  "auth",
  "realtime",
  "storage",
  "imgproxy",
  "studio",
  "edge_runtime",
  "analytics",
  "vector",
  "pooler",
  "inbucket",
  "pg_meta",
];

/** @param {string} config */
export function migrateSmtpConfig(config) {
  return config.replace(/^\[inbucket\]([ \t]*(?:#.*)?\r?)$/m, "[local_smtp]$1");
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, projectId: string, capture?: boolean }} options
 */
export function runSupabase(args, { cwd, projectId, capture = true }) {
  const result = spawnSync("supabase", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`supabase ${args[0]} failed`);
  }

  const expectedStopped = new Set(
    excludedContainers.map((name) => `supabase_${name}_${projectId}`),
  );
  // Successful commands repeat status summaries for services we intentionally
  // exclude. Keep every other diagnostic, and all stderr when a command fails.
  const stderr = result.stderr
    .split(/\r?\n/)
    .filter((line) => {
      const stopped = /^Stopped services: \[(.+)\]$/.exec(line);
      if (stopped) {
        return !stopped[1]
          .split(/\s+/)
          .every((name) => expectedStopped.has(name));
      }
      return (
        line.trim() !== "" &&
        line !== "supabase start is already running." &&
        line !== "supabase local development setup is running." &&
        !line.startsWith("A new version of Supabase CLI is available: ") &&
        !/^We recommend updating regularly for new features and bug fixes: https:\/\/supabase\.com\/docs\/guides\/cli\/getting-started#updating-the-supabase-cli$/.test(
          line,
        )
      );
    })
    .join("\n");
  if (stderr) process.stderr.write(`${stderr}\n`);
  // Supabase start/status stdout can contain credentials; only migration output
  // is explicitly forwarded by the caller.
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}
