import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ListSyncStatus } from "@stremlist/shared/sync-status";
import { listSyncState, mergedListSyncState } from "../src/lib/list-sync.ts";
import type { ListSyncState } from "../src/lib/list-sync.ts";

/** Assert only the fields of `expected`, like a partial match. */
function assertFields(actual: object, expected: Record<string, unknown>) {
  const picked = Object.fromEntries(
    Object.keys(expected).map((key) => [
      key,
      (actual as Record<string, unknown>)[key],
    ]),
  );
  assert.deepEqual(picked, expected);
}

describe("listSyncState", () => {
  const ok: ListSyncStatus = {
    provider: "trakt",
    sourceRef: "me/watchlist",
    lastAttemptAt: "2026-10-06T12:00:00.000Z",
    lastSuccessAt: "2026-10-06T12:00:00.000Z",
    titleCount: 42,
    problem: null,
    failingSince: null,
  };
  const failing = (
    problem: ListSyncStatus["problem"],
    overrides: Partial<ListSyncStatus> = {},
  ): ListSyncStatus => ({
    ...ok,
    lastAttemptAt: "2026-10-06T13:00:00.000Z",
    problem,
    failingSince: "2026-10-06T13:00:00.000Z",
    ...overrides,
  });

  test("waits for the first refresh of a new List", () => {
    assert.deepEqual(listSyncState(undefined, "none", false), {
      kind: "waiting",
      reconnected: false,
    });
  });

  test("shows when the last successful refresh happened", () => {
    assert.deepEqual(listSyncState(ok, "none", false), {
      kind: "synced",
      at: ok.lastSuccessAt,
      titleCount: 42,
    });
  });

  test("explains a failure and whether Stremio still shows older Titles", () => {
    assert.deepEqual(listSyncState(failing("private"), "none", false), {
      kind: "failing",
      problem: "private",
      since: "2026-10-06T13:00:00.000Z",
      olderTitlesFrom: ok.lastSuccessAt,
    });
    assertFields(
      listSyncState(
        failing("not_found", { lastSuccessAt: null, titleCount: null }),
        "none",
        false,
      ),
      { kind: "failing", olderTitlesFrom: null },
    );
    assertFields(
      listSyncState(failing("unavailable", { titleCount: 0 }), "none", false),
      { olderTitlesFrom: null },
    );
  });

  test("asks to connect a List that needs a missing Connection", () => {
    assert.deepEqual(listSyncState(undefined, "none", true), {
      kind: "connection",
      renew: false,
      stillShown: false,
    });
    assert.deepEqual(listSyncState(ok, "none", true), {
      kind: "connection",
      renew: false,
      stillShown: false,
    });
  });

  test("asks to renew a refused Connection", () => {
    // Even before the List's own next read fails: Stremio still serves its
    // cached Titles until then.
    assert.deepEqual(listSyncState(ok, "renew", true), {
      kind: "connection",
      renew: true,
      stillShown: true,
    });
    // A Source list whose read the Provider refused shows nothing.
    assert.deepEqual(
      listSyncState(failing("needs_connection"), "renew", false),
      { kind: "connection", renew: true, stillShown: false },
    );
    assert.deepEqual(listSyncState(undefined, "renew", true), {
      kind: "connection",
      renew: true,
      stillShown: false,
    });
  });

  test("keeps a public List synced while another List's Connection is refused", () => {
    assertFields(listSyncState(ok, "renew", false), { kind: "synced" });
  });

  test("waits for the read after a new Connection", () => {
    assert.deepEqual(listSyncState(failing("needs_connection"), "ok", true), {
      kind: "waiting",
      reconnected: true,
    });
  });

  test("does not claim older Titles for a List that lost its Connection", () => {
    assertFields(listSyncState(failing("needs_connection"), "none", false), {
      kind: "failing",
      olderTitlesFrom: null,
    });
  });
});

describe("mergedListSyncState", () => {
  const IMDB = { provider: "imdb", sourceRef: "ur1000001" } as const;
  const TRAKT = { provider: "trakt", sourceRef: "me/watchlist" } as const;
  const synced = (at: string): ListSyncState => ({
    kind: "synced",
    at,
    titleCount: 3,
  });
  const failing: ListSyncState = {
    kind: "failing",
    problem: "private",
    since: "2026-10-06T13:00:00.000Z",
    olderTitlesFrom: null,
  };

  test("keeps the state of a List with one Source list", () => {
    assert.deepEqual(
      mergedListSyncState([{ source: IMDB, state: failing }]),
      failing,
    );
  });

  test("is synced as of the oldest refresh, without a Title count", () => {
    assert.deepEqual(
      mergedListSyncState([
        { source: IMDB, state: synced("2026-10-06T12:00:00.000Z") },
        { source: TRAKT, state: synced("2026-10-06T10:00:00.000Z") },
      ]),
      { kind: "synced", at: "2026-10-06T10:00:00.000Z", titleCount: null },
    );
  });

  test("names the Source list that fails and says the others still show", () => {
    assert.deepEqual(
      mergedListSyncState([
        { source: IMDB, state: synced("2026-10-06T12:00:00.000Z") },
        { source: TRAKT, state: failing },
      ]),
      { ...failing, source: TRAKT, othersShown: true },
    );
    assert.deepEqual(
      mergedListSyncState([
        { source: IMDB, state: { kind: "waiting", reconnected: false } },
        { source: TRAKT, state: failing },
      ]),
      { ...failing, source: TRAKT, othersShown: false },
    );
  });

  test("puts a Connection problem before a failed refresh", () => {
    assert.deepEqual(
      mergedListSyncState([
        { source: IMDB, state: failing },
        {
          source: TRAKT,
          state: { kind: "connection", renew: false, stillShown: false },
        },
      ]),
      {
        kind: "connection",
        renew: false,
        stillShown: false,
        source: TRAKT,
        othersShown: false,
      },
    );
  });

  test("asks to renew one Source list while the others still show", () => {
    const refused: ListSyncStatus = {
      provider: "trakt",
      sourceRef: "me/watchlist",
      lastAttemptAt: "2026-10-06T13:00:00.000Z",
      lastSuccessAt: null,
      titleCount: null,
      problem: "needs_connection",
      failingSince: "2026-10-06T13:00:00.000Z",
    };
    assert.deepEqual(
      mergedListSyncState([
        { source: IMDB, state: synced("2026-10-06T12:00:00.000Z") },
        { source: TRAKT, state: listSyncState(refused, "renew", true) },
      ]),
      {
        kind: "connection",
        renew: true,
        stillShown: false,
        source: TRAKT,
        othersShown: true,
      },
    );
  });

  test("waits while one Source list waits for its first refresh", () => {
    assert.deepEqual(
      mergedListSyncState([
        { source: IMDB, state: synced("2026-10-06T12:00:00.000Z") },
        { source: TRAKT, state: { kind: "waiting", reconnected: true } },
      ]),
      { kind: "waiting", reconnected: true },
    );
  });
});
