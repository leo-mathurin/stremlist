import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ListSyncStatus } from "@stremlist/shared/sync-status";
import {
  attentionTone,
  listSyncState,
  mergedListSyncState,
  statusOfSource,
  syncLineTone,
} from "../src/lib/list-sync.ts";
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

describe("syncLineTone", () => {
  const renew = (
    stillShown: boolean,
    othersShown?: boolean,
  ): ListSyncState => ({
    kind: "connection",
    renew: true,
    stillShown,
    ...(othersShown === undefined ? {} : { othersShown }),
  });

  test("agrees with the row when Stremio still shows a refused List", () => {
    assert.equal(attentionTone(renew(true)), "warn");
    assert.equal(syncLineTone(renew(true), true), "warn");
  });

  test("is bad when a refused List shows nothing in Stremio", () => {
    assert.equal(syncLineTone(renew(false), true), "bad");
    assert.equal(syncLineTone(renew(false, true), true), "warn");
  });

  test("warns about a missing Connection, also before a save", () => {
    const missing: ListSyncState = {
      kind: "connection",
      renew: false,
      stillShown: false,
    };
    assert.equal(syncLineTone(missing, false), "warn");
  });

  test("follows the attention tone of a failed refresh", () => {
    const failing = (olderTitlesFrom: string | null): ListSyncState => ({
      kind: "failing",
      problem: "unavailable",
      since: "2026-10-06T13:00:00.000Z",
      olderTitlesFrom,
    });
    assert.equal(
      syncLineTone(failing("2026-10-06T12:00:00.000Z"), true),
      "warn",
    );
    assert.equal(syncLineTone(failing(null), true), "bad");
  });

  test("is ok for a saved synced List and idle otherwise", () => {
    const synced: ListSyncState = {
      kind: "synced",
      at: "2026-10-06T12:00:00.000Z",
      titleCount: 3,
    };
    assert.equal(syncLineTone(synced, true), "ok");
    assert.equal(syncLineTone(synced, false), "idle");
    assert.equal(
      syncLineTone({ kind: "waiting", reconnected: false }, true),
      "idle",
    );
  });
});

describe("statusOfSource", () => {
  const status: ListSyncStatus = {
    provider: "imdb",
    sourceRef: "imdb:top-rated-movies",
    lastAttemptAt: "2026-10-08T10:00:00.000Z",
    lastSuccessAt: "2026-10-08T10:00:00.000Z",
    titleCount: 250,
    problem: null,
    failingSince: null,
  };

  test("gives the status of the Source list at its position", () => {
    assert.equal(
      statusOfSource([status], 0, {
        provider: "imdb",
        sourceRef: "imdb:top-rated-movies",
      }),
      status,
    );
  });

  test("ignores a status about the Source list from before a save", () => {
    assert.equal(
      statusOfSource([status], 0, {
        provider: "imdb",
        sourceRef: "imdb:top-rated-tv",
      }),
      undefined,
    );
  });

  test("gives nothing for a Source list that was never read", () => {
    const source = { provider: "imdb", sourceRef: "ur12345678" } as const;
    assert.equal(statusOfSource([null], 0, source), undefined);
    assert.equal(statusOfSource(undefined, 0, source), undefined);
  });
});
