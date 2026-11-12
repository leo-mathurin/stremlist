import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";

vi.mock("../../../lib/supabase", () => ({ supabase: {} }));

import type { LibraryItem } from "../../stremio";
import { diffItems, withItems } from "../detect";
import type { WatchState } from "../state";

const SHOW = "tt0903747";
const episodes = [1, 2, 3].map((n) => ({
  id: `${SHOW}:1:${n}`,
  season: 1,
  episode: n,
}));

function field(watched: number[]): string {
  let bits = 0;
  for (const n of watched) bits |= 1 << (n - 1);
  const last = Math.max(...watched);
  return `${SHOW}:1:${last}:${last}:${deflateSync(Buffer.from([bits])).toString("base64")}`;
}

function series(watched: number[]): LibraryItem {
  return {
    _id: SHOW,
    type: "series",
    _mtime: "2026-11-12T20:00:00.000Z",
    state: { watched: field(watched), lastWatched: "2026-11-12T19:59:00.000Z" },
  };
}

function movie(timesWatched: number): LibraryItem {
  return {
    _id: "tt0063350",
    type: "movie",
    _mtime: "2026-11-12T20:00:00.000Z",
    state: { timesWatched },
  };
}

const empty: WatchState = { checkedAt: 0, savedAt: 0, movies: [], series: {} };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const id = /series\/(tt\d+)/.exec(url)?.[1] ?? SHOW;
      return Promise.resolve(
        Response.json({
          meta: {
            videos: episodes.map((v) => ({ ...v, id: v.id.replace(SHOW, id) })),
          },
        }),
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const titlesOf = async (state: WatchState, item: LibraryItem) =>
  (await diffItems(state, [item])).titles;

describe("new watched titles", () => {
  it("sends a movie once, dated by its change", async () => {
    expect(await titlesOf(empty, movie(0))).toEqual([]);
    const first = await diffItems(empty, [movie(1)]);
    expect(first.titles).toEqual([
      {
        imdbId: "tt0063350",
        type: "movie",
        watchedAt: "2026-11-12T20:00:00.000Z",
      },
    ]);
    expect(await titlesOf(first.next as WatchState, movie(2))).toEqual([]);
  });

  it("sends only the episodes that are new against the state", async () => {
    const state = withItems(empty, [series([1])]) as WatchState;
    expect(await titlesOf(state, series([1, 2, 3]))).toEqual(
      [2, 3].map((episode) => ({
        imdbId: SHOW,
        type: "series",
        episode: { season: 1, episode },
        watchedAt: "2026-11-12T19:59:00.000Z",
      })),
    );
    // Only the new episode counts, whatever else changed.
    expect(await titlesOf(state, series([2]))).toEqual([
      expect.objectContaining({ episode: { season: 1, episode: 2 } }),
    ]);
  });

  it("never sends an episode again, after an older read or a remark", async () => {
    const baseline = withItems(empty, [series([1])]) as WatchState;
    const sent = (await diffItems(baseline, [series([1, 2])]))
      .next as WatchState;
    expect(sent.series[SHOW]).toEqual(["1:1", "1:2"]);
    // An older read (episode 2 not yet watched) changes nothing.
    expect(await diffItems(sent, [series([1])])).toEqual({
      titles: [],
      next: false,
    });
    // Unmarked, then marked again: not sent twice.
    expect(await titlesOf(sent, series([2]))).toEqual([]);
    expect(await titlesOf(sent, series([1, 2, 3]))).toEqual([
      expect.objectContaining({ episode: { season: 1, episode: 3 } }),
    ]);
  });

  it("reads Cinemeta again when its list lacks the anchor episode", async () => {
    const fetchMock = vi.mocked(fetch);
    // First answer: an old list without episode 3.
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          meta: {
            videos: episodes
              .slice(0, 2)
              .map((v) => ({ ...v, id: v.id.replace(SHOW, "tt9999999") })),
          },
        }),
      ),
    );
    const other = { ...series([1, 3]), _id: "tt9999999" };
    other.state = {
      ...other.state,
      watched: other.state?.watched?.replaceAll(SHOW, "tt9999999"),
    };
    const titles = await titlesOf(empty, other);
    expect(titles.map((t) => t.episode)).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 3 },
    ]);
  });

  it("adopts a baseline that Cinemeta cannot place any more, sending nothing", async () => {
    // The baseline's anchor episode is not in Cinemeta's list (renumbered).
    const lost = { ...empty, series: { [SHOW]: `${SHOW}:9:9:3:eJxjAAAAAQAB` } };
    const { titles, next } = await diffItems(lost, [series([1, 2])]);
    expect(titles).toEqual([]);
    expect((next as WatchState).series[SHOW]).toEqual(["1:1", "1:2"]);
  });

  it("keeps an item that Cinemeta cannot place for the next sweep", async () => {
    const unplaced = {
      ...series([1]),
      _mtime: 40,
      state: { watched: `${SHOW}:9:9:3:eJxjAAAAAQAB` },
    };
    const { next } = await diffItems(empty, [unplaced], 100);
    // The sweep moves up to just before that item, not past it.
    expect((next as WatchState).checkedAt).toBe(39);
  });

  it("ignores titles from other addons' catalogs", async () => {
    const kitsu = { ...movie(1), _id: "kitsu:7442" };
    expect(await diffItems(empty, [kitsu])).toEqual({
      titles: [],
      next: false,
    });
    expect(withItems(empty, [kitsu])).toBe(false);
  });

  it("saves the baseline only when something changed", () => {
    expect(withItems(empty, [movie(0)])).toBe(false);
    const state = withItems(empty, [movie(1)], 50) as WatchState;
    expect(state).toMatchObject({ movies: ["tt0063350"], checkedAt: 50 });
    expect(withItems(state, [movie(3)], 40)).toBe(false);
    expect(withItems(state, [], 60)).toMatchObject({ checkedAt: 60 });
  });
});
