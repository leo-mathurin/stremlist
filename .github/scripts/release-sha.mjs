import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const VERSION_FILES = [
  "package.json",
  "packages/shared/src/constants.ts",
  "apps/frontend/src/content/changelog.json",
];
const VERSION_SUBJECT = /^chore\(release\): v\d+\.\d+\.\d+ \[skip ci\]$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function mainHead() {
  const [sha] = git(
    "ls-remote",
    "--exit-code",
    "origin",
    "refs/heads/main",
  ).split(/\s+/);
  return sha;
}

function isVersionBumpOf(sha, tested) {
  git("fetch", "--no-tags", "--quiet", "origin", sha, tested);
  const [, ...parents] = git("rev-list", "--parents", "-n", "1", sha).split(
    " ",
  );
  if (parents.length !== 1 || parents[0] !== tested) return false;
  if (!VERSION_SUBJECT.test(git("log", "-1", "--format=%s", sha))) {
    return false;
  }
  const changed = git("diff", "--name-only", tested, sha)
    .split("\n")
    .filter(Boolean);
  return changed.every((file) => VERSION_FILES.includes(file));
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    throw new Error(`${label} must be a full commit SHA, got "${value}"`);
  }
  return value;
}

const [mode, input] = process.argv.slice(2);
const sha = requireSha(input, mode === "assert" ? "release" : "tested");
const head = mainHead();

if (mode === "resolve") {
  let release;
  if (head === sha) release = sha;
  else if (isVersionBumpOf(head, sha)) release = head;
  else {
    throw new Error(
      `Obsolete deploy: tested ${sha}, but main is at ${head}. The run for the newer merge deploys it.`,
    );
  }
  console.log(`Release ${release} (tested ${sha})`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${release}\n`);
  }
} else if (mode === "assert") {
  if (head !== sha) {
    throw new Error(
      `Obsolete deploy: release ${sha}, but main is at ${head}. Nothing was written by this step.`,
    );
  }
  console.log(`main is still at ${sha}`);
} else {
  throw new Error("Usage: release-sha.mjs <resolve|assert> <sha>");
}
