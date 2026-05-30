// Determines the semver bump level from the Conventional Commits pushed to main.
//
// Reads the commit range from $BEFORE..$AFTER (the push event range), classifies
// each commit, and writes `bump`, `current_version`, and `new_version` to
// $GITHUB_OUTPUT. Bump is the highest level found:
//   feat                       -> minor
//   fix | perf                 -> patch
//   <type>! | BREAKING CHANGE: -> major
//   anything else              -> none (no release)
//
// Relies on merge commits preserving the branch's individual commits in the
// range. If you squash-merge instead, make the squash commit title conventional.
import { execSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";

const ZERO = "0".repeat(40);
const before = process.env.BEFORE ?? "";
const after = process.env.AFTER || "HEAD";

const range = !before || before === ZERO ? `${after}~1..${after}` : `${before}..${after}`;

// %x00 = NUL field separator, %x1e = record separator — safe against newlines in bodies.
let raw = "";
try {
  raw = execSync(`git log ${range} --format=%s%x00%b%x1e`, { encoding: "utf8" });
} catch {
  // Range unresolvable (e.g. force-push); fall back to the tip commit only.
  raw = execSync(`git log -1 ${after} --format=%s%x00%b%x1e`, { encoding: "utf8" });
}

const commits = raw
  .split("\x1e")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [subject = "", body = ""] = entry.split("\x00");
    return { subject, body };
  });

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
const TYPE_RE = /^(\w+)(?:\([^)]*\))?(!)?:/;
const BREAKING_RE = /(^|\n)BREAKING[ -]CHANGE:/;

let bump = "none";
const raise = (level) => {
  if (RANK[level] > RANK[bump]) bump = level;
};

for (const { subject, body } of commits) {
  const m = subject.match(TYPE_RE);
  if (m?.[2] === "!" || BREAKING_RE.test(body) || BREAKING_RE.test(subject)) {
    raise("major");
    continue;
  }
  if (!m) continue;
  const type = m[1].toLowerCase();
  if (type === "feat") raise("minor");
  else if (type === "fix" || type === "perf") raise("patch");
}

const current = JSON.parse(readFileSync("package.json", "utf8")).version;
const [maj, min, pat] = current.split(".").map(Number);
const next =
  bump === "major"
    ? `${maj + 1}.0.0`
    : bump === "minor"
      ? `${maj}.${min + 1}.0`
      : bump === "patch"
        ? `${maj}.${min}.${pat + 1}`
        : current;

console.log(`Analyzed ${commits.length} commit(s) in ${range}`);
console.log(`Bump: ${bump} (${current} -> ${next})`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `bump=${bump}\ncurrent_version=${current}\nnew_version=${next}\n`,
  );
}
