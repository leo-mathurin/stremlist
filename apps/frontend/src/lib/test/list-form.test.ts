import assert from "node:assert/strict";
import { test } from "node:test";
import { createListRow, newLocalId } from "../list-form.ts";

test("a List row gets a local ID on a page that is not a secure context", () => {
  const drawn: Uint8Array[] = [];
  const insecure: Pick<Crypto, "getRandomValues"> = {
    getRandomValues(array) {
      const values = crypto.getRandomValues(array);
      if (values instanceof Uint8Array) drawn.push(values.slice());
      return values;
    },
  };
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  const ids = [newLocalId(insecure), newLocalId(insecure)];
  assert.match(ids[0], /^[0-9a-f]{32}$/);
  assert.notEqual(ids[0], ids[1]);

  drawn.length = 0;
  const rows = [1, 2].map(() =>
    createListRow({ provider: "imdb", sourceRef: "ls123456789" }, insecure),
  );
  assert.match(rows[0].localId, /^[0-9a-f]{32}$/);
  assert.notEqual(rows[0].localId, rows[1].localId);
  assert.deepEqual(
    rows.map((row) => row.localId),
    drawn.map(hex),
  );
});
