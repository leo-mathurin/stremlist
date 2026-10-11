// The local stack started by `bun run dev:local`: Supabase containers and
// the R2-compatible container. Names and ports are derived the same way as
// scripts/dev-local.mjs, from the per-worktree project ID.
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const backendDir = fileURLToPath(new URL("../", import.meta.url));
export const STRESS_BUCKET = "stremlist-stress";

// The public local-development service-role key of the Supabase CLI, also
// used by dev-local.mjs when Auth is excluded.
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const R2_CREDENTIALS = {
  accessKeyId: "stremlist-local",
  secretAccessKey: "stremlist-local-secret",
};

export class StackError extends Error {}

export interface Stack {
  projectId: string;
  dbContainer: string;
  restContainer: string;
  r2Container: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { maxBuffer: 64 << 20 });
  return stdout;
}

async function hostPort(container: string, port: string): Promise<string> {
  const output = await docker(["port", container, port]).catch(() => "");
  const match = /:(\d+)\s*$/m.exec(output.split("\n")[0] ?? "");
  if (!match?.[1]) {
    throw new StackError(`${container} does not publish port ${port}.`);
  }
  return match[1];
}

/** Find the running local stack, or throw a StackError that says what to do. */
export async function findStack(): Promise<Stack> {
  const configPath = `${repoRoot}.dev.local/supabase/config.toml`;
  if (!existsSync(configPath)) {
    throw new StackError(`No local stack config at ${configPath}.`);
  }
  const projectId = /^project_id = "([\w-]+)"/m.exec(
    readFileSync(configPath, "utf8"),
  )?.[1];
  if (!projectId) throw new StackError(`No project_id in ${configPath}.`);

  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    throw new StackError("Docker is not running.");
  }
  const containers = {
    db: `supabase_db_${projectId}`,
    rest: `supabase_rest_${projectId}`,
    kong: `supabase_kong_${projectId}`,
    r2: `${projectId}-r2`,
  };
  const states = await docker([
    "inspect",
    "--format",
    "{{.Name}} {{.State.Running}}",
    ...Object.values(containers),
  ]).catch(() => "");
  for (const name of Object.values(containers)) {
    if (!states.includes(`/${name} true`)) {
      throw new StackError(`Container ${name} is not running.`);
    }
  }

  const stack: Stack = {
    projectId,
    dbContainer: containers.db,
    restContainer: containers.rest,
    r2Container: containers.r2,
    supabaseUrl: `http://127.0.0.1:${await hostPort(containers.kong, "8000/tcp")}`,
    serviceRoleKey: SERVICE_ROLE_KEY,
    r2Endpoint: `http://127.0.0.1:${await hostPort(containers.r2, "9000/tcp")}`,
    r2AccessKeyId: R2_CREDENTIALS.accessKeyId,
    r2SecretAccessKey: R2_CREDENTIALS.secretAccessKey,
  };
  const response = await fetch(
    `${stack.supabaseUrl}/rest/v1/accounts?select=id&limit=0`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    },
  ).catch(() => null);
  if (!response?.ok) {
    throw new StackError(
      `The local database does not answer (${String(response?.status ?? "no response")}).`,
    );
  }
  return stack;
}

/**
 * Run SQL with psql inside the database container, in one transaction.
 * Returns the last non-empty output line (the scripts end with a JSON row).
 */
export async function psql(
  stack: Stack,
  sql: string,
  variables: Record<string, string | number> = {},
): Promise<string> {
  const args = ["exec", "-i", stack.dbContainer, "psql", "-U", "postgres"];
  args.push("-d", "postgres", "-X", "-q", "-A", "-t", "-1");
  args.push("-v", "ON_ERROR_STOP=1");
  for (const [name, value] of Object.entries(variables)) {
    args.push("-v", `${name}=${String(value)}`);
  }
  args.push("-f", "-");
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`psql failed: ${stderr.trim() || String(code)}`));
        return;
      }
      const lines = stdout.split("\n").filter((line) => line.trim() !== "");
      resolve(lines.at(-1) ?? "");
    });
    child.stdin.end(sql);
  });
}

/** Rows of a query as arrays of strings (tab separated psql output). */
export async function query(stack: Stack, sql: string): Promise<string[][]> {
  const output = await docker([
    "exec",
    stack.dbContainer,
    "psql",
    "-U",
    "postgres",
    "-X",
    "-A",
    "-t",
    "-F",
    "\t",
    "-c",
    sql,
  ]);
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

export async function dockerCpu(
  containers: string[],
): Promise<Record<string, number>> {
  const output = await docker([
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}} {{.CPUPerc}}",
    ...containers,
  ]);
  const cpu: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const [name, percent] = line.trim().split(" ");
    if (name && percent) cpu[name] = Number.parseFloat(percent);
  }
  return cpu;
}

export function s3Client(stack: Stack): S3Client {
  return new S3Client({
    endpoint: stack.r2Endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.r2AccessKeyId,
      secretAccessKey: stack.r2SecretAccessKey,
    },
  });
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode;
}

async function bucketExists(s3: S3Client): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: STRESS_BUCKET }));
    return true;
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}

/** Every object of the stress bucket, page by page. */
async function* listObjects(
  s3: S3Client,
): AsyncGenerator<{ key: string; size: number }> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: STRESS_BUCKET,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) yield { key: object.Key, size: object.Size ?? 0 };
    }
    token = page.NextContinuationToken;
  } while (token);
}

async function emptyBucket(s3: S3Client): Promise<void> {
  let batch: { Key: string }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: STRESS_BUCKET,
        Delete: { Objects: batch, Quiet: true },
      }),
    );
    batch = [];
  };
  // Delete in a second pass: deleting while listing skips keys.
  const keys: string[] = [];
  for await (const object of listObjects(s3)) keys.push(object.key);
  for (const key of keys) {
    batch.push({ Key: key });
    if (batch.length === 1000) await flush();
  }
  await flush();
}

/** A fresh, empty stress bucket (a crashed run may have left one). */
export async function createBucket(stack: Stack): Promise<void> {
  const s3 = s3Client(stack);
  try {
    if (await bucketExists(s3)) await emptyBucket(s3);
    else await s3.send(new CreateBucketCommand({ Bucket: STRESS_BUCKET }));
  } finally {
    s3.destroy();
  }
}

export async function removeBucket(stack: Stack): Promise<void> {
  const s3 = s3Client(stack);
  try {
    if (!(await bucketExists(s3))) return;
    await emptyBucket(s3);
    await s3.send(new DeleteBucketCommand({ Bucket: STRESS_BUCKET }));
  } finally {
    s3.destroy();
  }
}

export type BucketUsage = Partial<
  Record<string, { objects: number; bytes: number }>
>;

/** Object count and bytes per top-level prefix ("history/", …). */
export async function bucketUsage(stack: Stack): Promise<BucketUsage> {
  const s3 = s3Client(stack);
  const usage: BucketUsage = {};
  try {
    for await (const { key, size } of listObjects(s3)) {
      const slash = key.indexOf("/");
      const prefix = slash === -1 ? "(root)" : key.slice(0, slash + 1);
      const entry = (usage[prefix] ??= { objects: 0, bytes: 0 });
      entry.objects++;
      entry.bytes += size;
    }
  } finally {
    s3.destroy();
  }
  return usage;
}
