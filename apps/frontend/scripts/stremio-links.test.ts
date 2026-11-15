import assert from "node:assert/strict";
import { test } from "node:test";
import { stremioDeepLink } from "../src/lib/stremio-links.ts";

test("an HTTPS Addon URL gets a deep link", () => {
  assert.equal(
    stremioDeepLink("https://api.stremlist.com/sl_abc/manifest.json"),
    "stremio://api.stremlist.com/sl_abc/manifest.json",
  );
});

test("an HTTP Addon URL has no deep link", () => {
  assert.equal(
    stremioDeepLink("http://api.stremlist.com/sl_abc/manifest.json"),
    null,
  );
});

test("an Addon URL with a port has no deep link", () => {
  assert.equal(
    stremioDeepLink("http://localhost:5173/api/sl_abc/manifest.json"),
    null,
  );
  assert.equal(
    stremioDeepLink("https://mac.tail.ts.net:8450/api/sl_abc/manifest.json"),
    null,
  );
});
