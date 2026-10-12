// The replay cache of the toolkit (README.md, "Cache rules").
//
//   bun toolkit-cache.ts replay [e2e run arguments]
//     Strict replay (CI=1, no credentials, --strict-cache), then `check`.
//   bun toolkit-cache.ts check [--prune]
//     Check the last run (.e2e/report.json) against .e2e/cache:
//     - every AI goal replayed its recording with zero model calls;
//     - no step always calls a model (agent.assert, waitFor, extract);
//     - every test with an AI goal has the `agent` tag, which
//       `test:toolkit:record` selects;
//     - every cache file is a valid recording for a test of this suite;
//     - after a run of the whole suite, no cache file is left unused
//       (`--prune` deletes those orphans);
//     - recordings hold no credential and only the toolkit app origins.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const cacheDir = join(root, ".e2e/cache");
const reportPath = join(root, ".e2e/report.json");
/** The toolkit app and its intercepted API (e2e.config.ts, config-fixture.ts). */
const ORIGINS = new Set(["http://127.0.0.1:4311", "http://127.0.0.1:4314"]);
const SECRET =
  /\b(?:sk-[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}|gh[pousr]_\w{20,}|re_[A-Za-z0-9]{20,})|Bearer [\w.-]{20,}/;

interface Step {
  api?: string;
  label: string;
  metrics?: { modelCalls?: number };
  cache?: { mode: string; reason?: string };
}
interface Result {
  testId: string;
  selected: boolean;
  tags?: string[];
  attempts: { steps: Step[] }[];
}
interface Report {
  run: {
    summary: { discovered: number; selected: number; executed: number };
    usage?: { modelTokens?: number };
    results: Result[];
  };
}
interface CacheEntry {
  schemaVersion?: string;
  payload?: {
    recordedFor?: {
      testId?: string;
      instructionDigest?: string;
      callIndex?: number;
    };
    startPath?: string;
    endPath?: string;
  };
}

/** The digest the e2e cache key uses for a goal (normalized template text). */
function instructionDigest(instruction: string): string {
  const text = instruction.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  return createHash("sha256").update(text).digest("hex");
}

const keyOf = (testId: string, digest: string, callIndex: number) =>
  `${testId}\n${digest}\n${String(callIndex)}`;

/** A route of a recording: relative, or on one of the toolkit origins. */
function onToolkitOrigin(path: string | undefined): boolean {
  if (!path || path.startsWith("/")) return true;
  try {
    return ORIGINS.has(new URL(path).origin);
  } catch {
    return false;
  }
}

function tracked(): Set<string> | null {
  try {
    const out = execFileSync("git", ["ls-files", "--", ".e2e/cache"], {
      cwd: root,
      encoding: "utf8",
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return null;
  }
}

function check(prune: boolean): boolean {
  const problems: string[] = [];
  const notes: string[] = [];

  // The recordings.
  const files = new Map<string, string>();
  const names = existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((name) => !name.startsWith("."))
    : [];
  for (const name of names) {
    const where = `.e2e/cache/${name}`;
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
      problems.push(`${where}: not a recording file name`);
      continue;
    }
    const text = readFileSync(join(cacheDir, name), "utf8");
    let entry: CacheEntry;
    try {
      entry = JSON.parse(text) as CacheEntry;
    } catch {
      problems.push(`${where}: not JSON`);
      continue;
    }
    const recordedFor = entry.payload?.recordedFor;
    if (
      entry.schemaVersion !== "trace-1" ||
      !recordedFor?.testId ||
      !recordedFor.instructionDigest ||
      typeof recordedFor.callIndex !== "number"
    ) {
      problems.push(`${where}: not a trace-1 recording with its test and goal`);
      continue;
    }
    if (SECRET.test(text)) problems.push(`${where}: holds a credential`);
    for (const path of [entry.payload?.startPath, entry.payload?.endPath]) {
      if (!onToolkitOrigin(path)) {
        problems.push(
          `${where}: route ${String(path)} is not on the toolkit app`,
        );
      }
    }
    files.set(
      keyOf(
        recordedFor.testId,
        recordedFor.instructionDigest,
        recordedFor.callIndex,
      ),
      name,
    );
  }

  // The last run.
  if (!existsSync(reportPath)) {
    problems.push("no .e2e/report.json: run the toolkit first");
    return report(problems, notes);
  }
  const { run } = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const used = new Set<string>();
  const testIds = new Set(run.results.map((result) => result.testId));
  let goals = 0;
  for (const result of run.results) {
    const hasGoal = result.attempts.some((attempt) =>
      attempt.steps.some((step) => step.api === "agent.act"),
    );
    if (hasGoal && !result.tags?.includes("agent")) {
      problems.push(
        `${decodeURIComponent(result.testId)} has an AI goal but no "agent" tag, so test:toolkit:record never records it`,
      );
    }
    for (const attempt of result.attempts) {
      const calls = new Map<string, number>();
      for (const step of attempt.steps) {
        if (!step.api?.startsWith("agent.")) continue;
        const where = `${decodeURIComponent(result.testId)}: ${step.api}("${step.label}")`;
        if (step.api !== "agent.act") {
          problems.push(`${where} always calls a model; use agent.act`);
          continue;
        }
        goals += 1;
        const digest = instructionDigest(step.label);
        const callIndex = calls.get(digest) ?? 0;
        calls.set(digest, callIndex + 1);
        const file = files.get(keyOf(result.testId, digest, callIndex));
        if (file) used.add(file);
        if ((step.metrics?.modelCalls ?? 0) > 0) {
          problems.push(
            `${where} made ${String(step.metrics?.modelCalls)} model call(s)`,
          );
        }
        if (step.cache?.mode !== "self-finalized") {
          const why = step.cache
            ? `${step.cache.mode}${step.cache.reason ? `, ${step.cache.reason}` : ""}`
            : "no cache";
          problems.push(
            `${where} did not replay (${why})${file ? `: ${file}` : ": no recording"}`,
          );
        }
      }
    }
  }
  if ((run.usage?.modelTokens ?? 0) > 0) {
    problems.push(
      `the run used ${String(run.usage?.modelTokens)} model tokens`,
    );
  }

  // Recordings of no current test, and, after a whole run, unused ones.
  const whole =
    run.results.every((result) => result.selected) &&
    run.summary.executed === run.summary.discovered;
  const orphans = [...files]
    .filter(([key, name]) => {
      const testId = key.split("\n")[0];
      return whole ? !used.has(name) : !testIds.has(testId);
    })
    .map(([, name]) => name);
  if (!whole) {
    notes.push(
      "the last run did not select every test: only recordings of unknown tests count as orphans",
    );
  }
  for (const name of orphans) {
    if (prune) {
      unlinkSync(join(cacheDir, name));
      notes.push(`deleted the orphan recording .e2e/cache/${name}`);
    } else {
      problems.push(
        `.e2e/cache/${name} is replayed by no current AI goal (orphan); delete it or run with --prune`,
      );
    }
  }

  const committed = tracked();
  if (committed) {
    for (const name of used) {
      if (!committed.has(`.e2e/cache/${name}`)) {
        notes.push(`.e2e/cache/${name} is not committed yet`);
      }
    }
  }
  notes.push(
    `${String(goals)} AI goal(s) checked, ${String(used.size)} of ${String(files.size)} recording(s) used`,
  );
  return report(problems, notes);
}

function report(problems: string[], notes: string[]): boolean {
  for (const note of notes) console.log(`toolkit cache: ${note}`);
  for (const problem of problems) console.error(`toolkit cache: ${problem}`);
  if (problems.length === 0) console.log("toolkit cache: OK");
  return problems.length === 0;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "replay") {
  const replay = spawnSync(
    join(root, "node_modules/.bin/e2e"),
    ["run", "--strict-cache", ...rest],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "1", E2E_OAUTH_CREDENTIALS: "{}" },
    },
  );
  const cacheOk = check(false);
  const status = replay.status ?? 1;
  process.exit(status !== 0 ? status : cacheOk ? 0 : 1);
} else if (command === "check") {
  process.exit(check(rest.includes("--prune")) ? 0 : 1);
} else {
  console.error(
    "Usage: bun toolkit-cache.ts replay [e2e run arguments] | check [--prune]",
  );
  process.exit(2);
}
