import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresReinstall } from "../src/lib/reinstall.ts";

const unchanged = {
  signature: "0|a|imdb|ur1||split|",
  actionsLive: false,
  newTitles: false,
};

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
      { signature: "", actionsLive: false, newTitles: false },
      {
        signature: "0|a|imdb|ur1||split|",
        actionsLive: false,
        newTitles: false,
      },
    ),
    true,
  );
});

test("an unknown baseline never asks for a reinstall", () => {
  assert.equal(
    requiresReinstall(
      { signature: null, actionsLive: null, newTitles: null },
      { signature: "0|a|imdb|ur1||split|", actionsLive: true, newTitles: true },
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

test("turning the New titles catalogs on or off needs a reinstall", () => {
  assert.equal(
    requiresReinstall(unchanged, { ...unchanged, newTitles: true }),
    true,
  );
});
