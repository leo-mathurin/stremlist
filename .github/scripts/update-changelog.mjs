import { readFileSync, writeFileSync } from "node:fs";
import { readCommits, withRelease } from "./changelog.mjs";

const CHANGELOG = "apps/frontend/src/content/changelog.json";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`Invalid version argument: ${version}`);
  process.exit(1);
}

const { range, commits } = readCommits(
  process.env.BEFORE ?? "",
  process.env.AFTER || "HEAD",
);
const versions = JSON.parse(readFileSync(CHANGELOG, "utf8"));
const next = withRelease(versions, { version, date: new Date() }, commits);

if (next === versions) {
  console.log(`v${version} is in ${CHANGELOG} already (${range})`);
} else {
  writeFileSync(CHANGELOG, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `Added v${version} to ${CHANGELOG} with ${next[0].changes.length} change(s) from ${range}`,
  );
}
