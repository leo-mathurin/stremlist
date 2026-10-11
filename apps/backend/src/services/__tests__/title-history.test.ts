import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/r2", async () => {
  return await import("../../__tests__/helpers/mock-r2.js");
});

import { r2Objects, r2Puts } from "../../__tests__/helpers/mock-r2.js";
import type { SourceHistory } from "../title-history";
import {
  applySynchronization,
  historyApplies,
  historyKey,
  listNewTitles,
  readHistory,
  recordHistory,
  REMOVED_ENTRY_RETENTION_MS,
} from "../title-history";

const SOURCE = { provider: "imdb" as const, sourceRef: "ur1" };
const PRIVATE = { provider: "trakt" as const, sourceRef: "me/history" };
const DAY_MS = 24 * 60 * 60_000;
const T0 = new Date("2026-10-01T00:00:00.000Z");

function at(days: number): Date {
  return new Date(T0.getTime() + days * DAY_MS);
}

function keyed(...ids: string[]) {
  return ids.map((id) => ({ key: `imdb:${id}`, imdbId: id }));
}

/** The history a recorded synchronization gave. */
function recorded(result: { history: SourceHistory } | null): SourceHistory {
  if (!result) throw new Error("expected a recorded synchronization");
  return result.history;
}

function apply(
  previous: SourceHistory | null,
  ids: string[],
  days: number,
): SourceHistory {
  const result = applySynchronization(
    previous,
    SOURCE,
    keyed(...ids),
    at(days),
    null,
  );
  if (!result) throw new Error("expected a recorded synchronization");
  return result.history;
}

describe("applySynchronization", () => {
  it("records the first synchronization as the Baseline", () => {
    const result = applySynchronization(
      null,
      SOURCE,
      keyed("tt1", "tt2"),
      at(0),
      null,
    );
    expect(result?.added).toBe(0);
    expect(result?.history.entries).toEqual({
      "imdb:tt1": ["tt1", null, null],
      "imdb:tt2": ["tt2", null, null],
    });
  });

  it("dates new entries, marks removals, and keeps a detection when an entry comes back", () => {
    let history = apply(null, ["tt1"], 0);
    history = apply(history, ["tt1", "tt2"], 1);
    expect(history.entries["imdb:tt2"]).toEqual([
      "tt2",
      at(1).toISOString(),
      null,
    ]);

    history = apply(history, ["tt1"], 2);
    expect(history.entries["imdb:tt2"][2]).toBe(at(2).toISOString());

    history = apply(history, ["tt1", "tt2"], 3);
    expect(history.entries["imdb:tt2"]).toEqual([
      "tt2",
      at(1).toISOString(),
      null,
    ]);
  });

  it("keeps the detection date of an entry that resolves later", () => {
    let history = apply(null, ["tt1"], 0);
    history = recorded(
      applySynchronization(
        history,
        SOURCE,
        [{ key: "trakt-movie:9", imdbId: null }],
        at(1),
        null,
      ),
    );
    history = recorded(
      applySynchronization(
        history,
        SOURCE,
        [{ key: "trakt-movie:9", imdbId: "tt9" }],
        at(2),
        null,
      ),
    );
    expect(history.entries["trakt-movie:9"]).toEqual([
      "tt9",
      at(1).toISOString(),
      null,
    ]);
  });

  it("refuses a synchronization that started before the recorded one", () => {
    const history = apply(apply(null, ["tt1"], 0), ["tt1", "tt2"], 2);
    expect(
      applySynchronization(history, SOURCE, keyed("tt1"), at(1), null),
    ).toBeNull();
  });

  it("forgets an entry removed longer ago than the retention", () => {
    let history = apply(null, ["tt1", "tt2"], 0);
    history = apply(history, ["tt1"], 1);
    const days = 1 + REMOVED_ENTRY_RETENTION_MS / DAY_MS;
    history = apply(history, ["tt1"], days + 1);
    expect(Object.keys(history.entries)).toEqual(["imdb:tt1"]);

    // It is new when it comes back.
    history = apply(history, ["tt1", "tt2"], days + 2);
    expect(history.entries["imdb:tt2"][1]).toBe(at(days + 2).toISOString());
  });

  it("says whether anything but the date changed", () => {
    const history = apply(null, ["tt1"], 0);
    expect(
      applySynchronization(history, SOURCE, keyed("tt1"), at(1), null)?.changed,
    ).toBe(false);
  });
});

describe("historyApplies", () => {
  const connection = { user: "leo", connectedAt: T0.toISOString() };
  const history = recorded(
    applySynchronization(null, PRIVATE, keyed("tt1"), at(0), connection),
  );

  it("needs the same Connection for a Connection-only Source list", () => {
    expect(historyApplies(history, PRIVATE, connection)).toBe(true);
    // Postgres gives the same time with microseconds.
    expect(
      historyApplies(history, PRIVATE, {
        ...connection,
        connectedAt: "2026-10-01T00:00:00.000000+00:00",
      }),
    ).toBe(true);
    expect(historyApplies(history, PRIVATE, null)).toBe(false);
    expect(
      historyApplies(history, PRIVATE, { ...connection, user: "sam" }),
    ).toBe(false);
    // A new Connection after a disconnect, even for the same user.
    expect(
      historyApplies(history, PRIVATE, {
        ...connection,
        connectedAt: at(1).toISOString(),
      }),
    ).toBe(false);
  });

  it("never applies to another Source list", () => {
    expect(
      historyApplies(
        history,
        { ...PRIVATE, sourceRef: "me/watchlist" },
        connection,
      ),
    ).toBe(false);
  });
});

describe("listNewTitles", () => {
  it("keeps the earliest detection across Source lists, newest first", () => {
    const other = {
      provider: "trakt" as const,
      sourceRef: "users/a/watchlist",
    };
    const first = apply(apply(null, ["tt0"], 0), ["tt0", "tt1", "tt2"], 1);
    const second = recorded(
      applySynchronization(
        recorded(applySynchronization(null, other, keyed("tt0"), at(0), null)),
        other,
        keyed("tt0", "tt2", "tt3"),
        at(3),
        null,
      ),
    );

    expect(
      listNewTitles(
        [
          { source: SOURCE, history: first },
          { source: other, history: second },
        ],
        10,
      ).map(({ imdbId, source, detectedAt }) => [
        imdbId,
        source.provider,
        detectedAt,
      ]),
    ).toEqual([
      ["tt3", "trakt", at(3).toISOString()],
      ["tt1", "imdb", at(1).toISOString()],
      ["tt2", "imdb", at(1).toISOString()],
    ]);
  });

  it("hides a Title that no Source list where it is new still has", () => {
    let history = apply(null, ["tt0"], 0);
    history = apply(history, ["tt0", "tt1"], 1);
    history = apply(history, ["tt0"], 2);
    expect(listNewTitles([{ source: SOURCE, history }], 10)).toEqual([]);
  });

  it("never lists a Title that one of its entries has in the Baseline", () => {
    let history = recorded(
      applySynchronization(
        null,
        SOURCE,
        [{ key: "imdb:tt1", imdbId: "tt1" }],
        at(0),
        null,
      ),
    );
    // The Provider gave the same Title a new key.
    history = recorded(
      applySynchronization(
        history,
        SOURCE,
        [
          { key: "imdb:tt1", imdbId: "tt1" },
          { key: "trakt-movie:1", imdbId: "tt1" },
        ],
        at(1),
        null,
      ),
    );
    expect(listNewTitles([{ source: SOURCE, history }], 10)).toEqual([]);
  });
});

describe("recordHistory", () => {
  beforeEach(() => {
    r2Objects.clear();
    r2Puts.count = 0;
  });
  afterEach(() => {
    r2Puts.before = null;
  });

  it("stores the Baseline, then the new entries", async () => {
    expect(await recordHistory("acc", SOURCE, keyed("tt1"), at(0), null)).toBe(
      0,
    );
    expect(
      await recordHistory("acc", SOURCE, keyed("tt1", "tt2"), at(1), null),
    ).toBe(1);
    expect((await readHistory("acc", SOURCE))?.lastSyncAt).toBe(
      at(1).toISOString(),
    );
  });

  it("skips the write when nothing changed, at most for a day", async () => {
    await recordHistory("acc", SOURCE, keyed("tt1"), at(0), null);
    expect(r2Puts.count).toBe(1);

    await recordHistory("acc", SOURCE, keyed("tt1"), at(0.5), null);
    expect(r2Puts.count).toBe(1);

    await recordHistory("acc", SOURCE, keyed("tt1"), at(1.5), null);
    expect((await readHistory("acc", SOURCE))?.lastSyncAt).toBe(
      at(1.5).toISOString(),
    );
  });

  it("compares with the version that another instance wrote in between", async () => {
    await recordHistory("acc", SOURCE, keyed("tt1"), at(0), null);
    const key = historyKey("acc", SOURCE);
    r2Puts.before = () => {
      r2Puts.before = null;
      // Another instance records tt2 just before this write.
      const stored = JSON.parse(r2Objects.get(key) ?? "") as SourceHistory;
      stored.entries["imdb:tt2"] = ["tt2", at(1).toISOString(), null];
      stored.lastSyncAt = at(1).toISOString();
      r2Objects.set(key, JSON.stringify(stored));
    };

    expect(
      await recordHistory(
        "acc",
        SOURCE,
        keyed("tt1", "tt2", "tt3"),
        at(2),
        null,
      ),
    ).toBe(1);
    expect(
      Object.keys((await readHistory("acc", SOURCE))?.entries ?? {}).sort(),
    ).toEqual(["imdb:tt1", "imdb:tt2", "imdb:tt3"]);
  });

  it("starts a new Baseline when the history belongs to another Connection", async () => {
    const leo = { user: "leo", connectedAt: T0.toISOString() };
    await recordHistory("acc", PRIVATE, keyed("tt1"), at(0), leo);
    expect(historyKey("acc", PRIVATE)).toMatch(/^connections\/acc\/trakt\//u);

    const sam = { user: "sam", connectedAt: T0.toISOString() };
    expect(
      await recordHistory("acc", PRIVATE, keyed("tt1", "tt2"), at(1), sam),
    ).toBe(0);
    expect((await readHistory("acc", PRIVATE))?.connection).toEqual(sam);
  });
});
