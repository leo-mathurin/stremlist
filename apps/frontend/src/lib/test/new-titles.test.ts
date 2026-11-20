import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_NEW_TITLES_SETTINGS } from "@stremlist/shared/manifest-catalogs";
import { createListRow } from "../list-form.ts";
import {
  addedNewTitles,
  catalogRows,
  followListChange,
  keptNewTitles,
  moveCatalogRow,
  NEW_TITLES_OFF,
  newTitlesFromAnswer,
  newTitlesPayload,
  newTitlesSort,
  newTitlesTitle,
} from "../new-titles.ts";
import type { NewTitlesForm } from "../new-titles.ts";

const [a, b, c] = ["ls1", "ls2", "ls3"].map((sourceRef) =>
  createListRow({ provider: "imdb", sourceRef }),
);

function at(position: number) {
  return {
    enabled: true,
    settings: { ...DEFAULT_NEW_TITLES_SETTINGS, position },
  } satisfies NewTitlesForm;
}

function order(lists: (typeof a)[], newTitles: NewTitlesForm) {
  return catalogRows(lists, newTitles).map((row) =>
    row.kind === "list" ? row.list.sourceRef : "new",
  );
}

describe("catalogRows", () => {
  test("puts New titles at its position among the Lists", () => {
    assert.deepEqual(order([a, b, c], at(0)), ["new", "ls1", "ls2", "ls3"]);
    assert.deepEqual(order([a, b, c], at(2)), ["ls1", "ls2", "new", "ls3"]);
  });

  test("keeps a position past the Lists at the end", () => {
    assert.deepEqual(order([a], at(5)), ["ls1", "new"]);
  });

  test("leaves New titles out while it is off", () => {
    assert.deepEqual(order([a, b], NEW_TITLES_OFF), ["ls1", "ls2"]);
  });
});

describe("moveCatalogRow", () => {
  test("moves New titles among the Lists without moving them", () => {
    const moved = moveCatalogRow([a, b, c], at(0), 0, 2);
    assert.deepEqual(
      moved.lists.map((list) => list.sourceRef),
      ["ls1", "ls2", "ls3"],
    );
    assert.equal(moved.position, 2);
  });

  test("moving a List past New titles shifts its position", () => {
    const moved = moveCatalogRow([a, b, c], at(1), 0, 2);
    assert.deepEqual(
      moved.lists.map((list) => list.sourceRef),
      ["ls2", "ls1", "ls3"],
    );
    assert.equal(moved.position, 0);
  });
});

describe("followListChange", () => {
  test("stays first when a List is added at the top", () => {
    assert.equal(followListChange(0, [a, b], [c, a, b]), 0);
  });

  test("stays after the same List when a List is added at the top", () => {
    assert.equal(followListChange(2, [a, b], [c, a, b]), 3);
  });

  test("moves up when a List above it is removed", () => {
    assert.equal(followListChange(2, [a, b, c], [b, c]), 1);
  });

  test("stays put when a List below it is removed", () => {
    assert.equal(followListChange(1, [a, b, c], [a, b]), 1);
  });
});

describe("the form", () => {
  test("an answer of an older backend gets the default settings", () => {
    assert.deepEqual(newTitlesFromAnswer({ enabled: true }), {
      enabled: true,
      settings: DEFAULT_NEW_TITLES_SETTINGS,
    });
  });

  test("a draft of the older page keeps its detection catalog types", () => {
    const lists = [
      createListRow({
        provider: "imdb",
        sourceRef: "ls1",
        displayMode: "movie",
      }),
    ];
    assert.deepEqual(keptNewTitles({ lists, newTitlesEnabled: true }), {
      enabled: true,
      settings: { ...DEFAULT_NEW_TITLES_SETTINGS, displayMode: "movie" },
    });
    const kept = at(3);
    assert.deepEqual(keptNewTitles({ lists, newTitles: kept }), kept);
  });

  test("adding it from Quick add puts it first with the defaults", () => {
    assert.deepEqual(addedNewTitles(), at(0));
  });

  test("a save sends the settings only while it is on", () => {
    assert.deepEqual(newTitlesPayload(NEW_TITLES_OFF), { enabled: false });
    const form = at(1);
    form.settings = { ...form.settings, catalogTitle: "  Fresh  " };
    assert.deepEqual(newTitlesPayload(form), {
      enabled: true,
      settings: { ...form.settings, catalogTitle: "Fresh" },
    });
  });

  test("an empty title shows the default name", () => {
    assert.equal(
      newTitlesTitle({ ...DEFAULT_NEW_TITLES_SETTINGS, catalogTitle: " " }),
      DEFAULT_NEW_TITLES_SETTINGS.catalogTitle,
    );
  });

  test("an unknown sort falls back to Recently detected", () => {
    assert.equal(newTitlesSort("added_at-asc"), "detected_at-desc");
    assert.equal(newTitlesSort("rating-desc"), "rating-desc");
  });
});
