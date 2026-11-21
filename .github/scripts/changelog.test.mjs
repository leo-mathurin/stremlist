import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogChanges, parseCommits, withRelease } from "./changelog.mjs";

const log = (...commits) =>
  commits
    .map(([subject, body = ""]) => [subject, body].join("\x00"))
    .join("\x1e\n");

const RELEASE = { version: "2.18.0", date: new Date("2026-11-21T23:30:00Z") };

test("reads the type, the breaking mark and the Changelog trailers", () => {
  assert.deepEqual(
    parseCommits(
      log(
        [
          "feat(trakt)!: add smart lists",
          "Why.\n\nChangelog: Smart lists.\nFixes STR-1\nchangelog: More\n  lists.\n",
        ],
        ["Merge pull request #1 from a/b"],
        ["chore: tidy\u2028up", "BREAKING CHANGE: drops v1"],
      ),
    ),
    [
      {
        type: "feat",
        description: "add smart lists",
        breaking: true,
        changelog: ["Smart lists.", "More lists."],
      },
      { type: null, description: "", breaking: false, changelog: [] },
      { type: "chore", description: "tidy", breaking: true, changelog: [] },
    ],
  );
});

test("lists features, then fixes, then performance, oldest first", () => {
  const commits = parseCommits(
    log(
      ["perf: read 10 Source lists at once"],
      ["fix(trakt): keep only started shows in Up Next"],
      ["test: cover the Up Next filter"],
      ["feat: sort a List by release date"],
      ["fix: open Trakt pages."],
      ["Merge pull request #2 from a/b"],
    ),
  );
  assert.deepEqual(changelogChanges(commits), [
    {
      type: "enhancement",
      label: "Feature",
      text: "Sort a List by release date.",
    },
    { type: "bugfix", label: "Bugfix", text: "Open Trakt pages." },
    {
      type: "bugfix",
      label: "Bugfix",
      text: "Keep only started shows in Up Next.",
    },
    {
      type: "performance",
      label: "Performance",
      text: "Read 10 Source lists at once.",
    },
  ]);
});

test("a Changelog trailer replaces the subject or leaves the commit out", () => {
  const commits = parseCommits(
    log(
      ["fix(lint): ignore computed keys", "Changelog: skip"],
      [
        "feat(db): add poster_source",
        "Changelog: Choose IMDb or TMDB posters.",
      ],
      ["refactor!: drop the v1 Addon URL"],
    ),
  );
  assert.deepEqual(changelogChanges(commits), [
    { type: "enhancement", label: "Change", text: "Drop the v1 Addon URL." },
    {
      type: "enhancement",
      label: "Feature",
      text: "Choose IMDb or TMDB posters.",
    },
  ]);
});

test("puts the release first with a long UTC date", () => {
  const versions = [{ version: "v2.17.0", date: "November 20, 2026" }];
  const next = withRelease(
    versions,
    RELEASE,
    parseCommits(log(["feat: add a thing"])),
  );
  assert.deepEqual(next, [
    {
      version: "v2.18.0",
      date: "November 21, 2026",
      changes: [
        { type: "enhancement", label: "Feature", text: "Add a thing." },
      ],
    },
    ...versions,
  ]);
});

test("keeps a release that is listed already", () => {
  const versions = [{ version: "v2.18.0", date: "November 21, 2026" }];
  const feat = parseCommits(log(["feat: add a thing"]));
  assert.equal(withRelease(versions, RELEASE, feat), versions);
});

test("a release with every commit left out gets a maintenance line", () => {
  const skipped = parseCommits(
    log(["fix: tidy", "Changelog: none"], ["constructor: x"]),
  );
  assert.deepEqual(withRelease([], RELEASE, skipped)[0].changes, [
    {
      type: "bugfix",
      label: "Reliability",
      text: "Maintenance release with no visible change.",
    },
  ]);
});
