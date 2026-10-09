import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListSource } from "@stremlist/shared/list-merge";
import {
  getListReinstallSignature,
  learnSourceGenres,
} from "../src/lib/reinstall-signature.ts";
import type {
  KnownSourceGenres,
  SignatureRow,
} from "../src/lib/reinstall-signature.ts";

// The signature must change exactly when the manifest that Stremio reads at
// install time changes (apps/backend/src/routes/manifest.ts): the Catalog
// IDs, names, types and genre options of each List, in order.

const FIRST: ListSource = { provider: "imdb", sourceRef: "ur1000001" };
const SECOND: ListSource = { provider: "imdb", sourceRef: "ls1000002" };
const WESTERN: ListSource = { provider: "trakt", sourceRef: "users/a/lists/w" };
const SERIES: ListSource = { provider: "imdb", sourceRef: "ls1000004" };

const genres: KnownSourceGenres = {
  "imdb:ur1000001": { movie: ["Drama"], series: [] },
  "imdb:ls1000002": { movie: ["Drama"], series: [] },
  "trakt:users/a/lists/w": { movie: ["Drama", "Western"], series: [] },
  "imdb:ls1000004": { movie: [], series: ["Animation"] },
};

function list(
  sources: ListSource[],
  overrides: Partial<SignatureRow & { sortOption: string }> = {},
): SignatureRow {
  const [first, ...mergedSources] = sources;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    localId: "row-1",
    ...first,
    mergedSources,
    catalogTitle: "Merged",
    displayMode: "split",
    catalogSettings: {},
    ...overrides,
  };
}

function signature(
  rows: SignatureRow[],
  known: KnownSourceGenres | null = genres,
) {
  return getListReinstallSignature(rows, known);
}

test("a merged Source list that brings a new genre changes the signature", () => {
  assert.notEqual(
    signature([list([FIRST, SECOND, WESTERN])]),
    signature([list([FIRST, SECOND])]),
  );
});

test("a merged Source list without a new genre keeps the signature", () => {
  assert.equal(signature([list([FIRST, SECOND])]), signature([list([FIRST])]));
  assert.equal(
    signature([list([FIRST, SECOND, WESTERN])]),
    signature([list([FIRST, WESTERN])]),
  );
});

test("the first Source list counts like the others", () => {
  // Removing the first Source list keeps the Catalog: same ID, name, type
  // and genres.
  assert.equal(signature([list([FIRST, SECOND])]), signature([list([SECOND])]));
  assert.notEqual(
    signature([list([WESTERN, FIRST])]),
    signature([list([FIRST])]),
  );
  // The order of the Source lists is not in the manifest.
  assert.equal(
    signature([list([FIRST, WESTERN])]),
    signature([list([WESTERN, FIRST])]),
  );
});

test("only the genres of the types that the List shows count", () => {
  assert.equal(
    signature([list([FIRST, SERIES], { displayMode: "movie" })]),
    signature([list([FIRST], { displayMode: "movie" })]),
  );
  assert.notEqual(
    signature([list([FIRST, SERIES])]),
    signature([list([FIRST])]),
  );
});

test("a Source list without known genres adds none", () => {
  const other: ListSource = { provider: "imdb", sourceRef: "ls9999999" };
  assert.equal(signature([list([FIRST, other])]), signature([list([FIRST])]));
});

test("Catalog types, names and presets change the signature", () => {
  const base = signature([list([FIRST])]);
  assert.notEqual(signature([list([FIRST], { displayMode: "movie" })]), base);
  assert.notEqual(signature([list([FIRST], { catalogTitle: "Other" })]), base);
  assert.notEqual(
    signature([list([FIRST], { catalogSettings: { presets: ["shuffle"] } })]),
    base,
  );
});

test("sort, Source list labels and title spaces keep the signature", () => {
  const base = signature([list([FIRST, SECOND])]);
  assert.equal(
    signature([list([FIRST, SECOND], { sortOption: "title-desc" })]),
    base,
  );
  assert.equal(
    signature([list([FIRST, { ...SECOND, label: "Renamed" }])]),
    base,
  );
  assert.equal(
    signature([list([FIRST, SECOND], { catalogTitle: " Merged " })]),
    base,
  );
});

test("an empty title has the name the backend gives it", () => {
  const second = (catalogTitle: string) =>
    list([SECOND], {
      id: "00000000-0000-4000-8000-000000000002",
      localId: "row-2",
      catalogTitle,
    });
  // The backend saves an empty title as the List's position (1-based).
  assert.equal(
    signature([list([FIRST]), second("")]),
    signature([list([FIRST]), second("2")]),
  );
});

test("a genre filter changes the signature only when it adds a genre option", () => {
  const base = signature([list([FIRST])]);
  assert.equal(
    signature([list([FIRST], { catalogSettings: { genre: "Drama" } })]),
    base,
  );
  assert.notEqual(
    signature([list([FIRST], { catalogSettings: { genre: "Horror" } })]),
    base,
  );
});

test("the order of the Lists changes the signature", () => {
  const other = list([SECOND], {
    id: "00000000-0000-4000-8000-000000000002",
    localId: "row-2",
    catalogTitle: "Other",
  });
  assert.notEqual(
    signature([list([FIRST]), other]),
    signature([other, list([FIRST])]),
  );
});

test("learned genres follow each Source list and keep what a cache gap hides", () => {
  const learned = learnSourceGenres({}, [
    {
      ...FIRST,
      mergedSources: [SECOND],
      sourceGenres: [
        { movie: ["Drama"], series: [] },
        { movie: ["Western"], series: [] },
      ],
    },
  ]);
  assert.deepEqual(learned, {
    "imdb:ur1000001": { movie: ["Drama"], series: [] },
    "imdb:ls1000002": { movie: ["Western"], series: [] },
  });
  // A Source list whose cache is not written yet (null) keeps its genres:
  // the manifest has them again once it is.
  assert.deepEqual(
    learnSourceGenres(learned, [{ ...SECOND, sourceGenres: [null] }]),
    learned,
  );
  // Older backends send no genres by Source list.
  assert.deepEqual(learnSourceGenres(learned, [{ ...FIRST }]), learned);
});

test("an older backend without genres by Source list leaves genre options out", () => {
  assert.equal(learnSourceGenres(null, [{ ...FIRST }]), null);
  // The page cannot tell which genres a change takes away.
  assert.equal(
    signature([list([FIRST, WESTERN])], null),
    signature([list([FIRST])], null),
  );
  assert.equal(
    signature([list([FIRST], { catalogSettings: { genre: "Horror" } })], null),
    signature([list([FIRST])], null),
  );
  assert.notEqual(
    signature([list([FIRST], { displayMode: "movie" })], null),
    signature([list([FIRST])], null),
  );
});

const withNewTitles = { newTitles: true };

test("turning the New titles Catalogs on or off changes the signature", () => {
  const rows = [list([FIRST])];
  assert.notEqual(
    getListReinstallSignature(rows, genres, withNewTitles),
    signature(rows),
  );
  // Without Lists, the manifest has no New titles Catalog to add.
  assert.equal(
    getListReinstallSignature([], genres, withNewTitles),
    signature([]),
  );
});

test("the New titles Catalogs follow the types that the Lists show", () => {
  const movies = list([FIRST], { displayMode: "movie" });
  const series = list([SERIES], {
    id: "00000000-0000-4000-8000-000000000002",
    localId: "row-2",
    displayMode: "series",
  });
  const entries = (rows: SignatureRow[]) =>
    (
      JSON.parse(getListReinstallSignature(rows, genres, withNewTitles)) as {
        newTitles?: true;
        type: string;
      }[]
    )
      .filter((entry) => entry.newTitles)
      .map((entry) => entry.type);
  assert.deepEqual(entries([movies]), ["movie"]);
  assert.deepEqual(entries([series, movies]), ["movie", "series"]);
});

test("with New titles off, the signature has the format of a stored reminder", () => {
  // Reminders saved before New titles keep matching.
  assert.equal(
    getListReinstallSignature([list([FIRST])], genres, { newTitles: false }),
    signature([list([FIRST])]),
  );
  assert.doesNotMatch(signature([list([FIRST])]), /newTitles/u);
});
