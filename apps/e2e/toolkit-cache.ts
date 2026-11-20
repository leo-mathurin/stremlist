import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord, isString, parseJson } from "./helpers/json.js";

const root = import.meta.dirname;
const cacheDir = join(root, ".e2e/cache");
const reportPath = join(root, ".e2e/report.json");
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
  status: string;
  tags?: string[];
  attempts: { steps: Step[] }[];
}
interface Report {
  run: {
    status: string;
    summary: { discovered: number };
    usage?: { modelTokens?: number };
    results: Result[];
  };
}
interface Recording {
  schemaVersion: "trace-1";
  payload: {
    recordedFor: {
      testId: string;
      instructionDigest: string;
      callIndex: number;
    };
    startPath?: unknown;
    endPath?: unknown;
  };
}

function isRecording(value: unknown): value is Recording {
  if (!isRecord(value) || value.schemaVersion !== "trace-1") return false;
  const { payload } = value;
  if (!isRecord(payload) || !isRecord(payload.recordedFor)) return false;
  const { testId, instructionDigest, callIndex } = payload.recordedFor;
  return (
    isString(testId) &&
    testId !== "" &&
    isString(instructionDigest) &&
    instructionDigest !== "" &&
    typeof callIndex === "number"
  );
}

function isStep(value: unknown): value is Step {
  return isRecord(value) && isString(value.label);
}

function isResult(value: unknown): value is Result {
  return (
    isRecord(value) &&
    isString(value.testId) &&
    typeof value.selected === "boolean" &&
    isString(value.status) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(
      (attempt) =>
        isRecord(attempt) &&
        Array.isArray(attempt.steps) &&
        attempt.steps.every(isStep),
    )
  );
}

function isReport(value: unknown): value is Report {
  return (
    isRecord(value) &&
    isRecord(value.run) &&
    isString(value.run.status) &&
    isRecord(value.run.summary) &&
    typeof value.run.summary.discovered === "number" &&
    Array.isArray(value.run.results) &&
    value.run.results.every(isResult)
  );
}

function instructionDigest(instruction: string) {
  const text = instruction.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  return createHash("sha256").update(text).digest("hex");
}

const keyOf = (testId: string, digest: string, callIndex: number) =>
  `${testId}\n${digest}\n${String(callIndex)}`;

function onToolkitOrigin(path: unknown) {
  if (!path) return true;
  if (!isString(path)) return false;
  if (path.startsWith("/")) return true;
  try {
    return ORIGINS.has(new URL(path).origin);
  } catch {
    return false;
  }
}

function tracked() {
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

function check(reportFile: string, mode: "partial" | "full" | "prune") {
  const problems: string[] = [];
  const notes: string[] = [];

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
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      problems.push(`${where}: not JSON`);
      continue;
    }
    if (!isRecording(entry)) {
      problems.push(`${where}: not a trace-1 recording with its test and goal`);
      continue;
    }
    const { recordedFor } = entry.payload;
    if (SECRET.test(text)) problems.push(`${where}: holds a credential`);
    for (const path of [entry.payload.startPath, entry.payload.endPath]) {
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

  if (!existsSync(reportFile)) {
    problems.push("no .e2e/report.json: run the toolkit first");
    return report(problems, notes);
  }
  const { run } = parseJson(
    readFileSync(reportFile, "utf8"),
    isReport,
    reportFile,
  );
  const allPassed =
    run.status === "passed" &&
    run.summary.discovered > 0 &&
    run.results.length === run.summary.discovered &&
    run.results.every(
      (result) => result.selected && result.status === "passed",
    );
  if (mode === "prune" && !allPassed) {
    problems.push(
      "Run the complete toolkit successfully before pruning recordings",
    );
    return report(problems, notes);
  }
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

  const replayedTests = new Set(
    run.results
      .filter((result) => result.status === "passed")
      .map((result) => result.testId),
  );
  const orphans = [...files]
    .filter(([key, name]) => {
      const testId = key.split("\n")[0];
      return (
        (mode !== "partial" && allPassed && !testIds.has(testId)) ||
        (replayedTests.has(testId) && !used.has(name))
      );
    })
    .map(([, name]) => name);
  if (mode === "prune" && problems.length > 0) return report(problems, notes);
  for (const name of orphans) {
    if (mode === "prune") {
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

function report(problems: string[], notes: string[]) {
  for (const note of notes) console.log(`toolkit cache: ${note}`);
  for (const problem of problems) console.error(`toolkit cache: ${problem}`);
  if (problems.length === 0) console.log("toolkit cache: OK");
  return problems.length === 0;
}

function strictReplay(args: string[]) {
  const replay = spawnSync(
    join(root, "node_modules/.bin/e2e"),
    ["run", "--strict-cache", ...args],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "1", E2E_OAUTH_CREDENTIALS: "{}" },
    },
  );
  return replay.status ?? 1;
}

function pruneAfterReplay() {
  const outputRoot = join(root, ".e2e");
  mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(join(outputRoot, "prune-"));
  try {
    const status = strictReplay([
      "--config",
      "e2e.config.ts",
      "--output",
      output,
    ]);
    if (status !== 0) return status;
    return check(join(output, "report.json"), "prune") ? 0 : 1;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "replay") {
  const status = strictReplay(rest);
  process.exit(
    status !== 0
      ? status
      : check(reportPath, rest.length ? "partial" : "full")
        ? 0
        : 1,
  );
} else if (command === "check" && rest.length === 0) {
  process.exit(check(reportPath, "partial") ? 0 : 1);
} else if (command === "check" && rest.length === 1 && rest[0] === "--prune") {
  process.exit(pruneAfterReplay());
} else {
  console.error(
    "Usage: bun toolkit-cache.ts replay [e2e run arguments] | check [--prune]",
  );
  process.exit(2);
}
