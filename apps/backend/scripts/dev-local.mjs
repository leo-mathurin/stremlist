import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workdir = `${root}.dev.local`;
const configPath = `${workdir}/supabase/config.toml`;

/** @param {string} command @param {string[]} args */
function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
  return result.stdout;
}

run("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true });
mkdirSync(`${workdir}/supabase`, { recursive: true });
if (!existsSync(configPath)) {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 8);
  // Separate worktrees use distinct container names and port ranges.
  const basePort = 56000 + (parseInt(id, 16) % 500) * 10;
  const config = readFileSync(`${root}supabase/config.toml`, "utf8")
    .replace(/^project_id = .*$/m, `project_id = "stremlist-dev-${id}"`)
    .replace(/\b5432(\d)\b/g, (_, digit) => String(basePort + Number(digit)))
    .replace(/^inspector_port = .*$/m, `inspector_port = ${basePort + 8}`);
  writeFileSync(configPath, config);
}
const config = readFileSync(configPath, "utf8");
const projectId = /^project_id = "([\w-]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error(`Missing project_id in ${configPath}`);
cpSync(`${root}supabase/migrations`, `${workdir}/supabase/migrations`, {
  recursive: true,
});

console.log("Starting local Supabase and applying pending migrations…");
// Supabase prints credentials in its startup summary; keep that stdout private.
run(
  "supabase",
  [
    "start",
    "--workdir",
    workdir,
    "-x",
    "gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta",
  ],
  { capture: true },
);
run("supabase", ["migration", "up", "--local", "--workdir", workdir]);
const status = z
  .object({
    API_URL: z.string().url(),
    SERVICE_ROLE_KEY: z.string().optional(),
  })
  .parse(
    JSON.parse(
      run("supabase", ["status", "--workdir", workdir, "-o", "json"], {
        capture: true,
      }),
    ),
  );
const api = new URL(status.API_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) {
  throw new Error("Local Supabase did not return a loopback API URL");
}
// The CLI omits keys from status when Auth is excluded. This is its public
// local-development service-role key, also used by the E2E stack.
const serviceKey =
  status.SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const database = await fetch(
  `${api.origin}/rest/v1/accounts?select=id&limit=0`,
  {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  },
);
if (!database.ok)
  throw new Error(`Local Accounts database check failed (${database.status})`);

const container = `${projectId}-r2`;
const containers = run("docker", ["ps", "-a", "--format", "{{.Names}}"], {
  capture: true,
})
  .trim()
  .split("\n");
if (containers.includes(container)) {
  run("docker", ["start", container], { capture: true });
} else {
  run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::9000",
      "-v",
      `${container}:/data`,
      "-e",
      "RUSTFS_ACCESS_KEY=stremlist-local",
      "-e",
      "RUSTFS_SECRET_KEY=stremlist-local-secret",
      "rustfs/rustfs:1.0.1",
      "/data",
    ],
    { capture: true },
  );
}
const port = run(
  "docker",
  [
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    container,
  ],
  { capture: true },
).trim();
if (!port) throw new Error("Local cache has no published port");
const endpoint = `http://127.0.0.1:${port}`;
const credentials = {
  accessKeyId: "stremlist-local",
  secretAccessKey: "stremlist-local-secret",
};
const storage = new S3Client({
  endpoint,
  region: "auto",
  forcePathStyle: true,
  credentials,
});
const Bucket = "stremlist-dev";
for (let attempt = 0; ; attempt++) {
  try {
    try {
      await storage.send(new HeadBucketCommand({ Bucket }));
    } catch (error) {
      if (
        !(error instanceof S3ServiceException) ||
        error.$metadata.httpStatusCode !== 404
      )
        throw error;
      await storage.send(new CreateBucketCommand({ Bucket }));
    }
    break;
  } catch (error) {
    if (attempt === 29) throw error;
    await setTimeout(1000);
  }
}
storage.destroy();
console.log(`Local database: ${api.origin}; cache: ${endpoint}`);
console.log("Local service data is preserved when you stop the dev servers.");

const child = spawn("bun", ["run", "dev"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
  env: {
    ...process.env,
    SUPABASE_URL: api.origin,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    R2_ENDPOINT: endpoint,
    R2_ACCESS_KEY_ID: credentials.accessKeyId,
    R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    R2_BUCKET: Bucket,
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
