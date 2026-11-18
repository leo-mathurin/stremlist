import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { deflateSync } from "node:zlib";
import type { LibraryItem } from "../../stremio";
import type * as StateModule from "../state";
import type { WatchState } from "../state";
import { onStreamRequest } from "../trigger";

const SHOW = "tt0903747";
const KEY = "sealed-key";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn<
    (
      name: string,
      args?: { p_rows?: unknown[] },
    ) => Promise<{ data: unknown; error: unknown }>
  >(),
  item: undefined as LibraryItem | undefined,
  state: null as WatchState | null,
  /** Saves refused as if another run saved first. */
  conflicts: 0,
}));

vi.mock("../../../lib/supabase", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("../../../lib/crypto", () => ({
  decryptSecret: (value: string) => value,
}));
vi.mock("../pace", () => ({
  readLibraryItems: () => Promise.resolve(mocks.item ? [mocks.item] : []),
}));
vi.mock("../state", async (importOriginal) => ({
  ...(await importOriginal<typeof StateModule>()),
  readState: () => Promise.resolve({ state: mocks.state, etag: "v1" }),
  writeState: (_: string, next: WatchState) => {
    if (mocks.conflicts > 0) {
      mocks.conflicts -= 1;
      return Promise.resolve(false);
    }
    mocks.state = next;
    return Promise.resolve(true);
  },
}));

const { linkOf } = await import("../state");

function field(watched: number[]): string {
  let bits = 0;
  for (const n of watched) bits |= 1 << (n - 1);
  const last = Math.max(...watched);
  return `${SHOW}:1:${last}:${last}:${deflateSync(Buffer.from([bits])).toString("base64")}`;
}

/** The series as Stremio's cloud has it: `watched` episodes, playing `on`. */
function series(watched: number[], on: number): LibraryItem {
  return {
    _id: SHOW,
    type: "series",
    _mtime: "2026-11-18T02:36:35.000Z",
    state: {
      watched: field(watched),
      lastWatched: "2026-11-18T02:36:00.000Z",
      video_id: `${SHOW}:1:${on}`,
      timeWatched: 0,
      duration: 2_767_658,
    },
  };
}

/** The watch state after episode 1 was sent. */
function sentUpTo(): WatchState {
  return {
    link: linkOf(KEY),
    checkedAt: 0,
    savedAt: 0,
    movies: [],
    series: { [SHOW]: ["1:1"] },
  };
}

let accounts = 0;
let account = "";

beforeEach(() => {
  // A new Account each time: the trigger caches the watch context.
  account = `sl_trigger${accounts++}`;
  mocks.rpc.mockImplementation((name: string) => {
    switch (name) {
      case "watch_context":
        return Promise.resolve({
          data: [{ auth_key: KEY, baseline_at: "2026-11-17T23:05:33Z" }],
          error: null,
        });
      case "watch_destination_list":
        return Promise.resolve({ data: ["mdblist"], error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          meta: {
            videos: [1, 2, 3].map((episode) => ({
              id: `${SHOW}:1:${episode}`,
              season: 1,
              episode,
            })),
          },
        }),
      ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  mocks.conflicts = 0;
  mocks.rpc.mockReset();
});

const calls = (name: string) =>
  mocks.rpc.mock.calls.filter(([called]) => called === name);
const queued = () =>
  calls("queue_watch_writes").flatMap(([, args]) => args?.p_rows ?? []);

describe("a /stream request of a tracked Account", () => {
  it("sends the episode that just turned watched before the next one restarts the cycle", async () => {
    // Episode 2 turned watched, but no read saw it before the app asked
    // for the streams of episode 3 (a client that sends no player events).
    mocks.state = sentUpTo();
    mocks.item = series([1, 2], 3);

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([
      expect.objectContaining({
        account_id: account,
        provider: "mdblist",
        imdb_id: SHOW,
        season: 1,
        episode: 2,
      }),
    ]);
    const order = mocks.rpc.mock.calls.map(([name]) => name);
    expect(order.indexOf("queue_watch_writes")).toBeLessThan(
      order.indexOf("watch_restart"),
    );
  });

  it("sends what is new even for an episode that is already watched", async () => {
    mocks.state = sentUpTo();
    mocks.item = series([1, 2], 2);

    await onStreamRequest(account, "series", `${SHOW}:1:2`);

    expect(queued()).toEqual([expect.objectContaining({ episode: 2 })]);
    // A replay of a watched episode starts no cycle.
    expect(calls("watch_restart")).toEqual([]);
  });

  it("sends nothing again for an episode already sent", async () => {
    mocks.state = { ...sentUpTo(), series: { [SHOW]: ["1:1", "1:2"] } };
    mocks.item = series([1, 2], 3);

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([]);
    // Nothing new: the Destinations are not even read.
    expect(calls("watch_destination_list")).toEqual([]);
    expect(calls("watch_restart")).toHaveLength(1);
  });

  it("still starts the cycle when the send fails", async () => {
    const queue = { data: null, error: { message: "queue is down" } };
    const answer = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation((name, args) =>
      name === "queue_watch_writes"
        ? Promise.resolve(queue)
        : (answer?.(name, args) ??
          Promise.resolve({ data: null, error: null })),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.state = sentUpTo();
    mocks.item = series([1, 2], 3);

    try {
      await onStreamRequest(account, "series", `${SHOW}:1:3`);

      expect(calls("queue_watch_writes")).toHaveLength(1);
      expect(calls("watch_restart")).toHaveLength(1);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("saves a baseline that Cinemeta cannot place any more, sending nothing", async () => {
    // The baseline's anchor episode is not in Cinemeta's list (renumbered).
    mocks.state = {
      ...sentUpTo(),
      series: { [SHOW]: `${SHOW}:9:9:3:eJxjAAAAAQAB` },
    };
    mocks.item = series([1, 2], 3);
    // Another run saves first: the save is tried again.
    mocks.conflicts = 1;

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([]);
    expect(calls("watch_destination_list")).toEqual([]);
    expect(mocks.conflicts).toBe(0);
    expect(mocks.state.series[SHOW]).toEqual(["1:1", "1:2"]);
  });

  it("sends nothing before the Watched baseline", async () => {
    const answer = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation((name, args) =>
      name === "watch_context"
        ? Promise.resolve({
            data: [{ auth_key: KEY, baseline_at: null }],
            error: null,
          })
        : (answer?.(name, args) ??
          Promise.resolve({ data: null, error: null })),
    );
    mocks.state = sentUpTo();
    mocks.item = series([1, 2], 3);

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([]);
    expect(calls("watch_restart")).toHaveLength(1);
  });
});
