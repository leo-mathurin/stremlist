import assert from "node:assert/strict";
import { test } from "node:test";
import { createListRow } from "../src/lib/list-form.ts";

test("a List row gets a local ID on a page that is not a secure context", () => {
  // Over plain http:// on a non-local host (a dev server on the tailnet),
  // the browser has crypto.getRandomValues but no crypto.randomUUID.
  const secure = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const insecure = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  };
  Object.defineProperty(globalThis, "crypto", {
    value: insecure,
    configurable: true,
  });
  try {
    const rows = [1, 2].map(() =>
      createListRow({ provider: "imdb", sourceRef: "ls123456789" }),
    );
    assert.match(rows[0].localId, /^[0-9a-f]{32}$/);
    assert.notEqual(rows[0].localId, rows[1].localId);
  } finally {
    if (secure) Object.defineProperty(globalThis, "crypto", secure);
  }
});
