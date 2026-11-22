import { readFileSync, appendFileSync } from "node:fs";
import { readCommits } from "./changelog.mjs";

const { range, commits } = readCommits(
  process.env.BEFORE ?? "",
  process.env.AFTER || "HEAD",
);

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
let bump = "none";
const raise = (level) => {
  if (RANK[level] > RANK[bump]) bump = level;
};

for (const { type, breaking } of commits) {
  if (breaking) raise("major");
  else if (type === "feat") raise("minor");
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
