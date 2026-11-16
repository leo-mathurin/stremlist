// node --test tools/git-hooks.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { huskyHooksPaths } from "./git-hooks.mjs";

test("finds Husky hook paths at every scope", () => {
  assert.deepEqual(
    huskyHooksPaths(
      [
        "local\t/home/leo/code/stremlist/.husky/_",
        "worktree\t.husky/_",
        "global\t.husky",
        "",
      ].join("\n"),
    ),
    [
      { scope: "local", value: "/home/leo/code/stremlist/.husky/_" },
      { scope: "worktree", value: ".husky/_" },
      { scope: "global", value: ".husky" },
    ],
  );
});

test("keeps the Vite+ dispatcher and other hook paths", () => {
  assert.deepEqual(
    huskyHooksPaths(
      [
        "local\t.vite-hooks/_",
        "global\t/etc/git-hooks",
        "local\tmy.husky/_",
      ].join("\n"),
    ),
    [],
  );
});
