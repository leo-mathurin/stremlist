// Enables the Vite+ Git hooks. `bun install` runs it through `prepare`.
//
//   bun tools/git-hooks.mjs
//
// `vp config` keeps any core.hooksPath it did not set. The repo used Husky
// before Vite+, so a checkout that installed an old commit can still point
// core.hooksPath at `.husky/_`. Worktrees share that setting, so every commit
// then runs the old Husky hook from another checkout. This script removes a
// Husky core.hooksPath from the repository config before `vp config` runs.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Scopes that belong to this repository. Global and system config belong to
// the machine, so the script only reports a Husky path there.
const REPO_SCOPES = new Set(["local", "worktree"]);

const isHuskyHooksPath = (value) =>
  /(^|[\\/])\.husky([\\/]_)?[\\/]?$/.test(value.trim());

/**
 * Finds the Husky core.hooksPath entries in the output of
 * `git config --show-scope --get-all core.hooksPath`.
 */
export function huskyHooksPaths(configOutput) {
  return configOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [scope, ...value] = line.split("\t");
      return { scope, value: value.join("\t") };
    })
    .filter(({ value }) => isHuskyHooksPath(value));
}

function git(...args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function removeHuskyHooksPath() {
  const result = git("config", "--show-scope", "--get-all", "core.hooksPath");
  if (result.status !== 0) return;

  for (const { scope, value } of huskyHooksPaths(result.stdout)) {
    if (!REPO_SCOPES.has(scope)) {
      console.warn(
        `core.hooksPath is "${value}" in your ${scope} Git config. ` +
          `Remove it with \`git config --${scope} --unset core.hooksPath\`, ` +
          "then run `bun install` again.",
      );
      continue;
    }
    const unset = git("config", `--${scope}`, "--unset-all", "core.hooksPath");
    if (unset.status !== 0) {
      throw new Error(
        `Could not remove core.hooksPath "${value}": ${unset.stderr.trim()}`,
      );
    }
    console.log(`Removed the old Husky core.hooksPath "${value}".`);
  }
}

function main() {
  if (git("rev-parse", "--git-dir").status === 0) removeHuskyHooksPath();

  const vp = spawnSync("vp", ["config", "--no-agent"], { stdio: "inherit" });
  if (vp.error) throw vp.error;
  process.exitCode = vp.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
