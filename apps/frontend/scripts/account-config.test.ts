import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import {
  configBody,
  reconcileActionProviders,
} from "../src/lib/account-config.ts";
import type { AccountForm } from "../src/lib/account-config.ts";
import {
  createListRow,
  listPayload,
  rowsFromLists,
} from "../src/lib/list-form.ts";

describe("reconcileActionProviders", () => {
  test("puts the saved Providers first, then the other capable ones", () => {
    assert.deepEqual(
      reconcileActionProviders(
        ["mdblist", "trakt"],
        ["mdblist", "trakt"],
        ["trakt", "simkl", "mdblist"],
      ),
      { order: ["mdblist", "trakt", "simkl"], selected: ["mdblist", "trakt"] },
    );
  });

  test("drops Providers that cannot have Actions any more", () => {
    assert.deepEqual(
      reconcileActionProviders(
        ["simkl", "trakt", "mdblist"],
        ["trakt", "simkl"],
        ["mdblist", "simkl"],
      ),
      { order: ["simkl", "mdblist"], selected: ["simkl"] },
    );
  });

  test("keeps the order and choice of an Account whose Providers did not change", () => {
    const current = {
      order: ["simkl", "trakt"] as const,
      selected: ["trakt"] as const,
    };
    assert.deepEqual(
      reconcileActionProviders(
        [...current.order],
        [...current.selected],
        ["trakt", "simkl"],
      ),
      { order: ["simkl", "trakt"], selected: ["trakt"] },
    );
  });
});

describe("configBody", () => {
  const form: AccountForm = {
    lists: [
      createListRow({
        provider: "imdb",
        sourceRef: " ur1000001 ",
        catalogTitle: " Watchlist ",
      }),
    ],
    rpdbApiKey: "key",
    actionsEnabled: true,
    actions: { order: ["simkl", "trakt"], selected: ["trakt", "simkl"] },
    newTitlesEnabled: true,
  };

  test("sends the Actions Providers that are on, in the chosen order", () => {
    assert.deepEqual(configBody(form, "private").actions, {
      enabled: true,
      providers: ["simkl", "trakt"],
    });
  });

  test("sends no Actions for a new setup or a Legacy alias", () => {
    assert.equal(configBody(form, "new").actions, undefined);
    assert.equal(configBody(form, "legacy").actions, undefined);
  });

  test("sends the trimmed Lists with their positions", () => {
    const body = configBody(form, "private");
    assert.equal(body.rpdbApiKey, "key");
    assert.deepEqual(body.newTitles, { enabled: true });
    assert.equal(body.lists[0].sourceRef, "ur1000001");
    assert.equal(body.lists[0].catalogTitle, "Watchlist");
    assert.equal(body.lists[0].position, 0);
  });
});

test("rows of saved Lists keep what the page edits and drop the rest", () => {
  const saved: ConfigList = {
    id: "list-1",
    provider: "trakt",
    sourceRef: "users/a/watchlist",
    catalogTitle: "Mine",
    sortOption: "title-asc",
    displayMode: "movie",
    position: 0,
    availableGenres: ["Drama"],
    sourceGenres: [{ movie: ["Drama"], series: [] }],
    catalogSettings: { genre: "Drama" },
    mergedSources: [{ provider: "imdb", sourceRef: "ls1000002" }],
    sourceLabel: "Mine",
  };
  const [row] = rowsFromLists([saved]);
  assert.ok(row.localId);
  assert.deepEqual(
    { ...row, localId: undefined },
    {
      id: "list-1",
      localId: undefined,
      provider: "trakt",
      sourceRef: "users/a/watchlist",
      catalogTitle: "Mine",
      sortOption: "title-asc",
      displayMode: "movie",
      catalogSettings: { genre: "Drama" },
      availableGenres: ["Drama"],
      mergedSources: [{ provider: "imdb", sourceRef: "ls1000002" }],
      sourceLabel: "Mine",
    },
  );
  assert.deepEqual(listPayload([row]), [
    {
      id: "list-1",
      provider: "trakt",
      sourceRef: "users/a/watchlist",
      catalogTitle: "Mine",
      sortOption: "title-asc",
      displayMode: "movie",
      position: 0,
      catalogSettings: { genre: "Drama" },
      mergedSources: [{ provider: "imdb", sourceRef: "ls1000002" }],
      sourceLabel: "Mine",
    },
  ]);
});
