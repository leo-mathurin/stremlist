import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSourceLink } from "@stremlist/shared/providers";
import { findLegacyInstall } from "../src/lib/legacy-install.ts";

/** A lookup over `installs` that records every request. */
function lookupOver(
  installs: string[],
  canonical: Record<string, string> = {},
) {
  const checked: string[] = [];
  const resolved: string[] = [];
  return {
    checked,
    resolved,
    lookup: {
      exists: (alias: string) => {
        checked.push(alias);
        return Promise.resolve(installs.includes(alias));
      },
      canonicalRef: (input: string) => {
        resolved.push(input);
        return Promise.resolve(canonical[input] ?? null);
      },
    },
  };
}

const find = (input: string, lookup: Parameters<typeof findLegacyInstall>[2]) =>
  findLegacyInstall(input, parseSourceLink(input), lookup);

test("a pasted IMDb user ID or watchlist link opens its v1 install", async () => {
  for (const input of [
    "ur12345678",
    "https://www.imdb.com/user/ur12345678/watchlist",
    "https://www.imdb.com/user/ur12345678/",
  ]) {
    const { lookup, resolved } = lookupOver(["ur12345678"]);
    assert.equal(await find(input, lookup), "ur12345678", input);
    assert.deepEqual(resolved, []);
  }
});

test("a pasted list ID never looks for a v1 install", async () => {
  // A public list is shared: its v1 install is not the person's who pastes it.
  const { lookup, checked } = lookupOver(["ls123456789"]);
  assert.equal(
    await find("https://www.imdb.com/list/ls123456789/", lookup),
    null,
  );
  assert.deepEqual(checked, []);
});

test("a p. handle opens the install keyed by the handle", async () => {
  const handle = "https://www.imdb.com/user/p.someone/";
  const { lookup, resolved } = lookupOver(["p.someone"]);
  assert.equal(await find(handle, lookup), "p.someone");
  assert.deepEqual(resolved, []);
});

test("a p. handle opens the install keyed by its canonical ID", async () => {
  const handle = "https://www.imdb.com/user/p.someone/";
  const { lookup, checked } = lookupOver(["ur12345678"], {
    [handle]: "ur12345678",
  });
  assert.equal(await find(handle, lookup), "ur12345678");
  assert.deepEqual(checked, ["p.someone", "ur12345678"]);
});

test("no install, or a link that is no IMDb ID, starts a new setup", async () => {
  const { lookup, checked } = lookupOver([]);
  assert.equal(await find("ur12345678", lookup), null);
  assert.equal(
    await find("https://www.imdb.com/user/p.someone/", lookup),
    null,
  );
  assert.equal(await find("imdb:top-rated-movies", lookup), null);
  assert.equal(
    await find("https://trakt.tv/users/ur12345678/watchlist", lookup),
    null,
  );
  assert.equal(await find("banana", lookup), null);
  assert.deepEqual(checked, ["ur12345678", "p.someone"]);
});

test("a failed check is not a missing install", async () => {
  await assert.rejects(
    findLegacyInstall("ur12345678", parseSourceLink("ur12345678"), {
      exists: () => Promise.reject(new Error("offline")),
      canonicalRef: () => Promise.resolve(null),
    }),
    /offline/,
  );
});
