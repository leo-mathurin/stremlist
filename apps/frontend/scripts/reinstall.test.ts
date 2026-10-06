import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresReinstall } from "../src/lib/reinstall.ts";

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
