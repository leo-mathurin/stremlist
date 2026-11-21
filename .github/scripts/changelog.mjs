import { execFileSync } from "node:child_process";

const ZERO = "0".repeat(40);
const FORMAT = "--format=%s%x00%b%x1e";
const CHANGELOG_RE = /^Changelog:[ \t]*(.*(?:\n[ \t]+.*)*)/gim;
const TYPE_RE = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.*)/;
const BREAKING_RE = /(^|\n)BREAKING[ -]CHANGE:/;
const SKIP_RE = /^(skip|none)$/i;
const KINDS = new Map([
  ["feat", { type: "enhancement", label: "Feature" }],
  ["fix", { type: "bugfix", label: "Bugfix" }],
  ["perf", { type: "performance", label: "Performance" }],
]);
const BREAKING_KIND = { type: "enhancement", label: "Change" };
const MAINTENANCE = {
  type: "bugfix",
  label: "Reliability",
  text: "Maintenance release with no visible change.",
};
const ORDER = ["enhancement", "bugfix", "performance"];

export function parseCommits(raw) {
  return raw
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x00");
      const match = subject.match(TYPE_RE);
      return {
        type: match?.[1].toLowerCase() ?? null,
        description: match?.[3] ?? "",
        breaking:
          match?.[2] === "!" ||
          BREAKING_RE.test(body) ||
          BREAKING_RE.test(subject),
        changelog: [...body.matchAll(CHANGELOG_RE)]
          .map((line) => line[1].replace(/\s+/g, " ").trim())
          .filter(Boolean),
      };
    });
}

export function readCommits(before, after) {
  const range =
    !before || before === ZERO ? `${after}~1..${after}` : `${before}..${after}`;
  const log = (...args) =>
    execFileSync("git", ["log", ...args, FORMAT], { encoding: "utf8" });
  let raw;
  try {
    raw = log(range);
  } catch {
    raw = log("-1", after);
  }
  return { range, commits: parseCommits(raw) };
}

function sentence(text) {
  const trimmed = text.trim();
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export function changelogChanges(commits) {
  return commits
    .toReversed()
    .flatMap((commit) => {
      const kind =
        KINDS.get(commit.type) ?? (commit.breaking ? BREAKING_KIND : null);
      if (!kind || !commit.type) return [];
      if (commit.changelog.some((line) => SKIP_RE.test(line))) return [];
      const texts =
        commit.changelog.length > 0 ? commit.changelog : [commit.description];
      return texts.map((text) => ({ ...kind, text: sentence(text) }));
    })
    .toSorted((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

export function withRelease(versions, release, commits) {
  const version = `v${release.version}`;
  if (versions.some((entry) => entry.version === version)) return versions;
  const listed = changelogChanges(commits);
  const changes = listed.length > 0 ? listed : [MAINTENANCE];
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(release.date);
  return [{ version, date, changes }, ...versions];
}
