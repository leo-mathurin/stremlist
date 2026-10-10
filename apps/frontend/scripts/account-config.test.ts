import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { joinProviderLabels } from "@stremlist/shared/providers";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import {
  accountEditPolicy,
  configBody,
  hasUnsavedChanges,
  reconcileActionProviders,
} from "../src/lib/account-config.ts";
import type { AccountForm } from "../src/lib/account-config.ts";
import {
  createListRow,
  listPayload,
  rowsFromLists,
} from "../src/lib/list-form.ts";
import {
  ACTION_PROVIDERS,
  CONNECTABLE_PROVIDERS,
} from "../src/lib/provider-groups.ts";

test("names the Providers with Connections and with Actions", () => {
  assert.equal(
    joinProviderLabels(CONNECTABLE_PROVIDERS),
    "Trakt, Simkl and MDBList",
  );
  assert.equal(
    joinProviderLabels(ACTION_PROVIDERS, "or"),
    "Trakt, Simkl or MDBList",
  );
});

describe("accountEditPolicy", () => {
  const moved =
    "This install has a private URL now. Make changes from the configure page of your new install.";

  test("lets a private Account change everything", () => {
    assert.deepEqual(accountEditPolicy("private", null), {
      editLock: undefined,
      actionsLock: undefined,
      upgradeToConnect: false,
      connectHint: null,
    });
  });

  test("asks a new setup to save and connect before Actions", () => {
    assert.deepEqual(accountEditPolicy("new", null), {
      editLock: undefined,
      actionsLock:
        "Save your setup and connect Trakt, Simkl or MDBList to use Actions.",
      upgradeToConnect: false,
      connectHint: "save-first",
    });
  });

  test("asks a Legacy alias install to upgrade before Connections and Actions", () => {
    assert.deepEqual(accountEditPolicy("legacy", null), {
      editLock: undefined,
      actionsLock:
        "Actions need a private Addon URL. Upgrade this install first.",
      upgradeToConnect: true,
      connectHint: "upgrade",
    });
  });

  test("locks a Legacy alias install that already has a private copy", () => {
    assert.deepEqual(accountEditPolicy("legacy", "2026-10-01T00:00:00.000Z"), {
      editLock: moved,
      actionsLock: moved,
      upgradeToConnect: true,
      connectHint: null,
    });
  });
});

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

  describe("hasUnsavedChanges", () => {
    test("is false when nothing changed after the save started", () => {
      assert.equal(hasUnsavedChanges(form, { ...form }, "private"), false);
    });

    test("sees a List or option edit made while the save was in flight", () => {
      assert.equal(
        hasUnsavedChanges(form, { ...form, rpdbApiKey: "other" }, "private"),
        true,
      );
      assert.equal(
        hasUnsavedChanges(form, { ...form, lists: [] }, "private"),
        true,
      );
    });

    test("sees an Actions edit made while the save was in flight", () => {
      assert.equal(
        hasUnsavedChanges(form, { ...form, actionsEnabled: false }, "private"),
        true,
      );
      assert.equal(
        hasUnsavedChanges(
          form,
          { ...form, actions: { ...form.actions, order: ["trakt", "simkl"] } },
          "private",
        ),
        true,
      );
    });

    test("ignores Actions where a save does not send them", () => {
      assert.equal(
        hasUnsavedChanges(form, { ...form, actionsEnabled: false }, "legacy"),
        false,
      );
    });
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
