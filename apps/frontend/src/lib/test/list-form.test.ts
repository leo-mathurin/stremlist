import assert from "node:assert/strict";
import { test } from "node:test";
import { createListRow, newLocalId } from "../list-form.ts";

test("a List row gets a local ID on a page that is not a secure context", () => {
  const insecure = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  } satisfies Pick<Crypto, "getRandomValues">;
  const ids = [newLocalId(insecure), newLocalId(insecure)];
  assert.match(ids[0], /^[0-9a-f]{32}$/);
  assert.notEqual(ids[0], ids[1]);

  const rows = [1, 2].map(() =>
    createListRow({ provider: "imdb", sourceRef: "ls123456789" }),
  );
  assert.match(rows[0].localId, /^[0-9a-f]{32}$/);
  assert.notEqual(rows[0].localId, rows[1].localId);
});
