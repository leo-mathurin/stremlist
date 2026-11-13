import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MergeableList } from "@stremlist/shared/list-merge";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import {
  connectProviderOf,
  missingConnections,
  previewConnectionKey,
} from "../src/lib/connections.ts";

const trakt: ConnectionSummary = {
  provider: "trakt",
  username: "a",
  connectedAt: "2026-10-01T00:00:00.000Z",
  needsRenewalSince: null,
};

// A Simkl watchlist needs a Connection; an IMDb watchlist does not.
const merged: MergeableList = {
  provider: "imdb",
  sourceRef: "ur1000001",
  mergedSources: [{ provider: "simkl", sourceRef: "watchlist" }],
};

describe("missingConnections", () => {
  test("names the Providers that the List needs and the Account lacks", () => {
    assert.deepEqual(missingConnections(merged, [trakt]), ["simkl"]);
    assert.deepEqual(
      missingConnections(merged, [
        trakt,
        { ...trakt, provider: "simkl", username: null },
      ]),
      [],
    );
  });
});

describe("connectProviderOf", () => {
  test("follows the Source list of a Connection problem", () => {
    assert.equal(
      connectProviderOf(
        merged,
        {
          kind: "connection",
          renew: true,
          stillShown: false,
          source: { provider: "trakt", sourceRef: "me/watchlist" },
          othersShown: true,
        },
        ["simkl"],
      ),
      "trakt",
    );
  });

  test("else asks for the first missing Connection, else the List's Provider", () => {
    assert.equal(connectProviderOf(merged, null, ["simkl"]), "simkl");
    assert.equal(connectProviderOf(merged, null, []), "imdb");
  });
});

describe("previewConnectionKey", () => {
  const list: MergeableList = {
    provider: "trakt",
    sourceRef: "me/watchlist",
    mergedSources: [{ provider: "imdb", sourceRef: "ls1000002" }],
  };

  test("is empty without a Connection to a Provider of the List", () => {
    assert.equal(previewConnectionKey(list, []), "");
    assert.equal(
      previewConnectionKey(list, [{ ...trakt, provider: "simkl" }]),
      "",
    );
  });

  test("changes when the Connection needs renewal or comes back", () => {
    const connected = previewConnectionKey(list, [trakt]);
    const refused = previewConnectionKey(list, [
      { ...trakt, needsRenewalSince: "2026-10-02T00:00:00.000Z" },
    ]);
    const again = previewConnectionKey(list, [
      { ...trakt, connectedAt: "2026-10-03T00:00:00.000Z" },
    ]);
    assert.notEqual(connected, "");
    assert.notEqual(refused, connected);
    assert.notEqual(again, connected);
  });
});
