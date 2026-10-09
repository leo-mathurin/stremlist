import assert from "node:assert/strict";
import { test } from "node:test";
import { reinstallState, requiresReinstall } from "../src/lib/reinstall.ts";

const unchanged = { signature: "0|a|imdb|ur1||split|", actionsLive: false };

test("an unchanged save needs no reinstall", () => {
  assert.equal(requiresReinstall(unchanged, unchanged), false);
});

test("changed catalogs need a reinstall", () => {
  assert.equal(
    requiresReinstall(unchanged, { ...unchanged, signature: "other" }),
    true,
  );
});

test("the first List of an Account saved without Lists needs a reinstall", () => {
  assert.equal(
    requiresReinstall(
      { signature: "", actionsLive: false },
      { signature: "0|a|imdb|ur1||split|", actionsLive: false },
    ),
    true,
  );
});

test("an unknown baseline never asks for a reinstall", () => {
  assert.equal(
    requiresReinstall(
      { signature: null, actionsLive: null },
      { signature: "0|a|imdb|ur1||split|", actionsLive: true },
    ),
    false,
  );
});

test("turning Actions on or off needs a reinstall", () => {
  assert.equal(
    requiresReinstall(unchanged, { ...unchanged, actionsLive: true }),
    true,
  );
});

const changed = { signature: "other", actionsLive: false };

test("a saved catalog change needs a reinstall", () => {
  // The installed baseline is what Stremio read, not the last save, so a
  // later save that keeps these catalogs keeps the reminder.
  assert.equal(reinstallState(unchanged, changed, changed), "required");
});

test("saving the installed catalogs back clears the reminder", () => {
  assert.equal(reinstallState(unchanged, unchanged, unchanged), "none");
});

test("unsaved catalog edits need a reinstall after saving", () => {
  assert.equal(reinstallState(unchanged, unchanged, changed), "after-save");
});

test("unsaved edits back to the installed catalogs stay required until saved", () => {
  assert.equal(reinstallState(unchanged, changed, unchanged), "required");
});

test("an unknown baseline never asks for a reinstall", () => {
  const unknown = { signature: null, actionsLive: null };
  assert.equal(reinstallState(unknown, unknown, changed), "none");
});
