// Load test of the real backend against the local stack, with IMDb faked.
// Usage: bun run stress:load [--accounts 6000] [--scenarios cold,warm,trakt,stale]
// See stress/README.md.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { encryptSecret } from "../src/lib/crypto";
import {
  evaluate,
  formatScenario,
  formatStorage,
  readSummary,
  totals,
} from "./report";
import type { Check, Peaks, ScenarioResult, ServerStats } from "./report";
import {
  backendDir,
  bucketUsage,
  createBucket,
  dockerCpu,
  findStack,
  psql,
  query,
  removeBucket,
  repoRoot,
  STRESS_BUCKET,
  StackError,
} from "./stack";
import type { Stack } from "./stack";

const SCENARIOS = {
  cold: "Cold storm: each Account opens its board once, empty caches",
  warm: "Warm ramp: random Accounts at a rising arrival rate",
  trakt: "Trakt outage: Trakt down while Action users open titles",
  stale: "Stale storm: 1 minute cache TTL and lists that change",
} as const;
type ScenarioName = keyof typeof SCENARIOS;
const ORDER: ScenarioName[] = ["cold", "warm", "trakt", "stale"];
const TRAKT_ACCOUNTS = 50;
const ENCRYPTION_KEY = Buffer.alloc(32, "k").toString("base64");

const HELP = `Usage: bun run stress:load [options]

Options (or the matching STRESS_* environment variable):
  --accounts <n>        Accounts to seed (STRESS_ACCOUNTS, default 6000)
  --scenarios <list>    Comma separated: cold,warm,trakt,stale (STRESS_SCENARIOS, default all)
  --base-latency <ms>   Fake IMDb latency per call (STRESS_BASE_LATENCY, default 300)
  --item-latency <ms>   Extra fake IMDb latency per title (STRESS_ITEM_LATENCY, default 0.3)
  --warm-rate <n>       Peak board opens per second in the warm ramp (STRESS_WARM_RATE, default 150)
  --stale-rate <n>      Board opens per second in the stale storm (STRESS_STALE_RATE, default 60)
  --hold <s>            Seconds of each steady phase (STRESS_HOLD, default 60)
  --vus <n>             Parallel users in the cold storm (STRESS_VUS, default 100)
  --port <n>            Port of the stress server (STRESS_PORT, default 7099)
  -h, --help            Show this help

Start the local stack first: bun run dev:local`;

function parseOptions() {
  const { values } = parseArgs({
    options: {
      accounts: { type: "string" },
      scenarios: { type: "string" },
      "base-latency": { type: "string" },
      "item-latency": { type: "string" },
      "warm-rate": { type: "string" },
      "stale-rate": { type: "string" },
      hold: { type: "string" },
      vus: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return null;
  const number = (flag: string | undefined, env: string, fallback: number) => {
    const raw = flag ?? process.env[env];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid number for ${env}: ${raw}`);
    }
    return value;
  };
  const scenarioList = (values.scenarios ?? process.env.STRESS_SCENARIOS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of scenarioList) {
    if (!(name in SCENARIOS)) throw new Error(`Unknown scenario: ${name}`);
  }
  const accounts = Math.round(number(values.accounts, "STRESS_ACCOUNTS", 6000));
  if (accounts < 10) throw new Error("Use at least 10 Accounts.");
  return {
    accounts,
    scenarios: ORDER.filter(
      (name) => scenarioList.length === 0 || scenarioList.includes(name),
    ),
    baseLatency: number(values["base-latency"], "STRESS_BASE_LATENCY", 300),
    itemLatency: number(values["item-latency"], "STRESS_ITEM_LATENCY", 0.3),
    warmRate: number(values["warm-rate"], "STRESS_WARM_RATE", 150),
    staleRate: number(values["stale-rate"], "STRESS_STALE_RATE", 60),
    hold: number(values.hold, "STRESS_HOLD", 60),
    vus: number(values.vus, "STRESS_VUS", 100),
    port: number(values.port, "STRESS_PORT", 7099),
  };
}
type Options = NonNullable<ReturnType<typeof parseOptions>>;

class Aborted extends Error {}

const stressDir = `${backendDir}stress/`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = `${repoRoot}.dev.local/stress/${stamp}/`;
const report: string[] = [];

function print(text: string): void {
  console.log(text);
  report.push(text);
}

let server: { child: ChildProcess; stale: boolean } | null = null;
let k6: ChildProcess | null = null;
let stopping = false;
let cleanup: Promise<boolean> | null = null;

function checkAborted(): void {
  if (stopping) throw new Aborted("Stopped by a signal.");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const { child } = server;
  server = null;
  child.kill("SIGTERM");
  await waitForExit(child, 5000);
}

async function startServer(
  stack: Stack,
  options: Options,
  stale: boolean,
): Promise<void> {
  if (server?.stale === stale) return;
  await stopServer();
  const base = `http://127.0.0.1:${String(options.port)}`;
  if (await fetch(`${base}/__stress/stats`).catch(() => null)) {
    throw new Error(`Port ${String(options.port)} is already in use.`);
  }
  const log = `${outDir}server-${stale ? "stale" : "normal"}.log`;
  const fd = openSync(log, "a");
  // A minimal environment: never the developer's .env (bun --no-env-file).
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    STRESS_PORT: String(options.port),
    SUPABASE_URL: stack.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    R2_ENDPOINT: stack.r2Endpoint,
    R2_ACCESS_KEY_ID: stack.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: stack.r2SecretAccessKey,
    R2_BUCKET: STRESS_BUCKET,
    CONNECTION_ENCRYPTION_KEY: ENCRYPTION_KEY,
    BACKEND_PUBLIC_URL: base,
    FRONTEND_URL: "http://localhost:5173",
    RESEND_API_KEY: "re_dummy_stress",
    TRAKT_CLIENT_ID: "stress-trakt-id",
    TRAKT_CLIENT_SECRET: "stress-trakt-secret",
    MOCK_BASE_MS: String(options.baseLatency),
    MOCK_PER_ITEM_MS: String(options.itemLatency),
    ...(stale ? { CACHE_TTL_MINUTES: "1", MOCK_DRIFT: "1" } : {}),
  };
  const child = spawn("bun", ["--no-env-file", "stress/server.ts"], {
    cwd: backendDir,
    env,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  server = { child, stale };
  for (let attempt = 0; attempt < 120; attempt++) {
    checkAborted();
    if (child.exitCode !== null) break;
    const response = await fetch(`${base}/__stress/stats`).catch(() => null);
    if (response?.ok) return;
    await sleep(250);
  }
  throw new Error(`The stress server did not start. See ${log}`);
}

async function serverCall<T>(options: Options, path: string): Promise<T> {
  const response = await fetch(
    `http://127.0.0.1:${String(options.port)}/__stress/${path}`,
  );
  if (!response.ok) throw new Error(`Stress server ${path} failed`);
  return (await response.json()) as T;
}

/** DB connections and container CPU, sampled until stop() is called. */
function startSampler(stack: Stack) {
  const peaks: Peaks = { dbConnections: 0, dbActive: 0, cpu: {} };
  const containers = [
    stack.dbContainer,
    stack.restContainer,
    stack.r2Container,
  ];
  const short = (name: string) =>
    name === stack.dbContainer
      ? "postgres"
      : name === stack.restContainer
        ? "postgrest"
        : "r2";
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      try {
        const row = (
          await query(
            stack,
            "select count(*), count(*) filter (where state = 'active') from pg_stat_activity where datname = 'postgres'",
          )
        ).at(0);
        peaks.dbConnections = Math.max(peaks.dbConnections, Number(row?.[0]));
        peaks.dbActive = Math.max(peaks.dbActive, Number(row?.[1]) - 1);
        const cpu = await dockerCpu(containers);
        for (const [name, value] of Object.entries(cpu)) {
          const key = short(name);
          peaks.cpu[key] = Math.max(peaks.cpu[key] ?? 0, value);
        }
      } catch {
        // Sampling is best effort; the scenario result does not depend on it.
      }
      await sleep(2000);
    }
  })();
  return {
    peaks,
    stop: async () => {
      state.running = false;
      await loop;
      return peaks;
    },
  };
}

async function runK6(
  name: ScenarioName,
  script: string,
  env: Record<string, string>,
): Promise<string> {
  const summary = `${outDir}summary-${name}.json`;
  const log = `${outDir}k6-${name}.log`;
  const fd = openSync(log, "a");
  const args = ["run", "--no-color", "-e", `SUMMARY=${summary}`];
  for (const [key, value] of Object.entries(env))
    args.push("-e", `${key}=${value}`);
  args.push(`${stressDir}k6/${script}`);
  const child = spawn(process.env.K6 ?? "k6", args, {
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  k6 = child;
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  k6 = null;
  checkAborted();
  if (code !== 0)
    throw new Error(`k6 ${name} exited with ${String(code)}. See ${log}`);
  return summary;
}

async function seedTrakt(
  stack: Stack,
): Promise<{ file: string; accounts: number }> {
  process.env.CONNECTION_ENCRYPTION_KEY = ENCRYPTION_KEY;
  const output = await psql(
    stack,
    readFileSync(`${stressDir}sql/trakt.sql`, "utf8"),
    {
      count: TRAKT_ACCOUNTS,
      access: encryptSecret("stress-access"),
      refresh: encryptSecret("stress-refresh"),
    },
  );
  const setup = JSON.parse(output) as {
    accounts: string[] | null;
    trakt: unknown;
  };
  if (!setup.accounts?.length || !setup.trakt) {
    throw new Error("No private stress Account to connect to Trakt.");
  }
  const file = `${outDir}actions.json`;
  writeFileSync(file, output);
  return { file, accounts: setup.accounts.length };
}

async function runScenario(
  name: ScenarioName,
  stack: Stack,
  options: Options,
  targets: string,
): Promise<{ result: ScenarioResult; checks: Check[] }> {
  await startServer(stack, options, name === "stale");
  let traktAccounts: number | undefined;
  let script = "board.js";
  const env: Record<string, string> = {
    BASE: `http://127.0.0.1:${String(options.port)}`,
    TARGETS: targets,
  };
  if (name === "cold") {
    Object.assign(env, { MODE: "cold", VUS: String(options.vus) });
  } else if (name === "warm") {
    const third = Math.max(1, Math.round(options.warmRate / 3));
    env.MODE = "warm";
    env.STAGES = JSON.stringify([
      { target: third, duration: "20s" },
      { target: third, duration: `${String(options.hold)}s` },
      { target: Math.round(options.warmRate), duration: "30s" },
      {
        target: Math.round(options.warmRate),
        duration: `${String(options.hold)}s`,
      },
    ]);
  } else if (name === "stale") {
    // Long enough for list caches to expire and refresh more than once.
    const target = Math.max(1, Math.round(options.staleRate));
    const hold = Math.round(Math.max(90, options.hold * 2.5));
    env.MODE = "warm";
    env.STAGES = JSON.stringify([
      { target, duration: "20s" },
      { target, duration: `${String(hold)}s` },
    ]);
  } else {
    const seeded = await seedTrakt(stack);
    traktAccounts = seeded.accounts;
    script = "actions.js";
    env.ACTIONS = seeded.file;
  }

  await serverCall(options, "reset");
  const sampler = startSampler(stack);
  const started = Date.now();
  process.stdout.write(`${SCENARIOS[name]}… `);
  let summary: string;
  try {
    summary = await runK6(name, script, env);
  } finally {
    await sampler.stop();
  }
  console.log(`done in ${String(Math.round((Date.now() - started) / 1000))} s`);
  const serverStats = await serverCall<ServerStats>(options, "stats").catch(
    () => null,
  );
  const result: ScenarioResult = {
    name,
    title: SCENARIOS[name].split(":")[0] ?? name,
    ...readSummary(summary),
    server: serverStats,
    peaks: sampler.peaks,
    traktAccounts,
  };
  return { result, checks: evaluate(result) };
}

async function databaseSize(stack: Stack): Promise<number> {
  const rows = await query(stack, "select pg_database_size('postgres')");
  return Number(rows.at(0)?.[0] ?? 0);
}

async function cleanUp(stack: Stack): Promise<boolean> {
  const status = { ok: true };
  const step = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      status.ok = false;
      console.error(
        `Cleanup: ${label} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  };
  if (k6) {
    k6.kill("SIGTERM");
    await waitForExit(k6, 10_000);
  }
  await step("stop the stress server", stopServer);
  await step("delete the stress Accounts", () =>
    psql(stack, readFileSync(`${stressDir}sql/cleanup.sql`, "utf8")),
  );
  await step(`remove the ${STRESS_BUCKET} bucket`, () => removeBucket(stack));
  console.log(
    status.ok ? "Cleanup: done." : "Cleanup: incomplete, see the errors above.",
  );
  return status.ok;
}

async function main(): Promise<number> {
  const options = parseOptions();
  if (!options) {
    console.log(HELP);
    return 0;
  }
  let stack: Stack;
  try {
    stack = await findStack();
  } catch (error) {
    if (!(error instanceof StackError)) throw error;
    console.error(
      `${error.message}\nRun \`bun run dev:local\` first (in apps/backend), then try again.`,
    );
    return 1;
  }
  const k6Version = spawnSync(process.env.K6 ?? "k6", ["version"], {
    encoding: "utf8",
  });
  if (k6Version.status !== 0) {
    console.error(
      "k6 is not installed (https://grafana.com/docs/k6/latest/set-up/install-k6/), or set K6 to its path.",
    );
    return 1;
  }
  mkdirSync(outDir, { recursive: true });

  const doCleanup = () => (cleanup ??= cleanUp(stack));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping and cleaning up…`);
      server?.child.kill("SIGTERM");
      // Exit now: the main flow may still wait on a long seed or query.
      // eslint-disable-next-line n/no-process-exit
      void doCleanup().finally(() => process.exit(130));
    });
  }

  print(
    `Stress run: ${options.accounts.toLocaleString("en-US")} Accounts, scenarios ${options.scenarios.join(", ")}, IMDb latency ${String(options.baseLatency)} ms + ${String(options.itemLatency)} ms/title`,
  );
  print(`Stack ${stack.projectId}; output in ${outDir}`);
  let failed = false;
  try {
    await psql(stack, readFileSync(`${stressDir}sql/cleanup.sql`, "utf8"));
    await createBucket(stack);
    const before = await databaseSize(stack);
    checkAborted();

    process.stdout.write(
      `Seeding ${options.accounts.toLocaleString("en-US")} Accounts… `,
    );
    const targets = `${outDir}targets.json`;
    writeFileSync(
      targets,
      await psql(stack, readFileSync(`${stressDir}sql/seed.sql`, "utf8"), {
        n: options.accounts,
      }),
    );
    console.log("done");

    const results: string[] = [];
    for (const name of options.scenarios) {
      checkAborted();
      const { result, checks } = await runScenario(
        name,
        stack,
        options,
        targets,
      );
      if (checks.some((check) => !check.pass)) failed = true;
      if (totals(result).requests === 0) failed = true;
      results.push(formatScenario(result, checks));
    }
    await stopServer();

    const tables = await query(
      stack,
      `select c.relname, greatest(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by pg_total_relation_size(c.oid) desc limit 8`,
    );
    const storage = formatStorage(
      { before, after: await databaseSize(stack) },
      tables,
      await bucketUsage(stack),
    );
    print("");
    for (const block of [...results, storage]) print(`${block}\n`);
  } catch (error) {
    failed = true;
    if (!(error instanceof Aborted)) {
      print(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (!(await doCleanup())) failed = true;
  }
  print(failed ? "RESULT: FAIL" : "RESULT: PASS");
  writeFileSync(`${outDir}report.txt`, `${report.join("\n")}\n`);
  return failed ? 1 : 0;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
