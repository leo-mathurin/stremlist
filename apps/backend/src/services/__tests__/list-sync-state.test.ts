import type { ListSyncStatus } from "@stremlist/shared/sync-status";
import { listSyncState } from "@stremlist/shared/sync-status";
import { describe, expect, it } from "vitest";

describe("listSyncState", () => {
  const ok: ListSyncStatus = {
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

  it("waits for the first refresh of a new List", () => {
    expect(listSyncState(undefined, "none", false)).toEqual({
      kind: "waiting",
      reconnected: false,
    });
  });

  it("shows when the last successful refresh happened", () => {
    expect(listSyncState(ok, "none", false)).toEqual({
      kind: "synced",
      at: ok.lastSuccessAt,
      titleCount: 42,
    });
  });

  it("explains a failure and whether Stremio still shows older Titles", () => {
    expect(listSyncState(failing("private"), "none", false)).toEqual({
      kind: "failing",
      problem: "private",
      since: "2026-10-06T13:00:00.000Z",
      olderTitlesFrom: ok.lastSuccessAt,
    });
    expect(
      listSyncState(
        failing("not_found", { lastSuccessAt: null, titleCount: null }),
        "none",
        false,
      ),
    ).toMatchObject({ kind: "failing", olderTitlesFrom: null });
    expect(
      listSyncState(failing("unavailable", { titleCount: 0 }), "none", false),
    ).toMatchObject({ olderTitlesFrom: null });
  });

  it("asks to connect a List that needs a missing Connection", () => {
    expect(listSyncState(undefined, "none", true)).toEqual({
      kind: "connection",
      renew: false,
      stillShown: false,
    });
    expect(listSyncState(ok, "none", true)).toEqual({
      kind: "connection",
      renew: false,
      stillShown: false,
    });
  });

  it("asks to renew a refused Connection", () => {
    // Even before the List's own next read fails: Stremio still serves its
    // cached Titles until then.
    expect(listSyncState(ok, "renew", true)).toEqual({
      kind: "connection",
      renew: true,
      stillShown: true,
    });
    // A Source list whose read the Provider refused shows nothing.
    expect(listSyncState(failing("needs_connection"), "renew", false)).toEqual({
      kind: "connection",
      renew: true,
      stillShown: false,
    });
    expect(listSyncState(undefined, "renew", true)).toEqual({
      kind: "connection",
      renew: true,
      stillShown: false,
    });
  });

  it("keeps a public List synced while another List's Connection is refused", () => {
    expect(listSyncState(ok, "renew", false)).toMatchObject({
      kind: "synced",
    });
  });

  it("waits for the read after a new Connection", () => {
    expect(listSyncState(failing("needs_connection"), "ok", true)).toEqual({
      kind: "waiting",
      reconnected: true,
    });
  });

  it("does not claim older Titles for a List that lost its Connection", () => {
    expect(
      listSyncState(failing("needs_connection"), "none", false),
    ).toMatchObject({ kind: "failing", olderTitlesFrom: null });
  });
});
