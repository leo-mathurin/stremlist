import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { deflateSync } from "node:zlib";
import { encryptSecret } from "../../../lib/crypto";
import { useTestEncryptionKey } from "../../../test/helpers/account.fixture";
import {
  r2Objects,
  r2Puts,
  resetR2,
} from "../../../test/helpers/r2.test-utils";
import { resetRpc, rpcHandlers } from "../../../test/helpers/mock-supabase";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import type { RpcArgs } from "../../../test/helpers/supabase/rpc";
import { rpcError } from "../../../test/helpers/supabase/rpc";
import type { Result } from "../../../test/helpers/supabase/store";
import type { LibraryItem } from "../../stremio";
import type { WatchState } from "../state";
import { linkOf, readState } from "../state";
import { onStreamRequest } from "../trigger";

const SHOW = "tt0903747";
const AUTH_KEY = "stremio-auth-key";
const server = useMswServer();

useTestEncryptionKey();
const KEY = encryptSecret(AUTH_KEY);

function field(watched: number[]) {
  let bits = 0;
  for (const n of watched) bits |= 1 << (n - 1);
  const last = Math.max(...watched);
  return `${SHOW}:1:${last}:${last}:${deflateSync(Buffer.from([bits])).toString("base64")}`;
}

function series(watched: number[], on: number) {
  const item: LibraryItem = {
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
  return item;
}

function sentUpTo() {
  const state: WatchState = {
    link: linkOf(KEY),
    checkedAt: 0,
    savedAt: 0,
    movies: [],
    series: { [SHOW]: ["1:1"] },
  };
  return state;
}

let accounts = 0;
let account = "";
let calls: { name: string; args: RpcArgs }[] = [];
let library: LibraryItem[] = [];

function stateKey() {
  return `watch/${account}/state.json`;
}

function saveState(state: WatchState) {
  r2Objects.set(stateKey(), JSON.stringify(state));
}

async function storedState() {
  return (await readState(account)).state;
}

const nothing = () => {
  const result: Result = { data: null, error: null };
  return result;
};

function recorded(name: string, answer: () => Result = nothing) {
  rpcHandlers.set(name, (args) => {
    calls.push({ name, args });
    return answer();
  });
}

function baselineContext(baselineAt: string | null) {
  recorded("watch_context", () => ({
    data: [{ auth_key: KEY, baseline_at: baselineAt }],
    error: null,
  }));
}

beforeEach(() => {
  account = `sl_trigger${accounts++}`;
  calls = [];
  library = [];
  baselineContext("2026-11-17T23:05:33Z");
  recorded("watch_destination_list", () => ({
    data: ["mdblist"],
    error: null,
  }));
  recorded("queue_watch_writes");
  recorded("watch_restart");
  recorded("watch_read_soon");
  server.use(
    http.post("https://api.strem.io/api/datastoreGet", () =>
      HttpResponse.json({ result: library }),
    ),
    http.get("https://v3-cinemeta.strem.io/meta/series/:file", () =>
      HttpResponse.json({
        meta: {
          videos: [1, 2, 3].map((episode) => ({
            id: `${SHOW}:1:${episode}`,
            season: 1,
            episode,
          })),
        },
      }),
    ),
  );
});
afterEach(() => {
  resetRpc();
  resetR2();
});

const callsTo = (name: string) => calls.filter((call) => call.name === name);
const queued = () =>
  callsTo("queue_watch_writes").flatMap(({ args }) => {
    const rows: unknown[] = Array.isArray(args.p_rows) ? args.p_rows : [];
    return rows;
  });

describe("a /stream request of a tracked Account", () => {
  it("sends the episode that just turned watched before the next one restarts the cycle", async () => {
    saveState(sentUpTo());
    library = [series([1, 2], 3)];

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
    const order = calls.map(({ name }) => name);
    expect(order.indexOf("queue_watch_writes")).toBeLessThan(
      order.indexOf("watch_restart"),
    );
  });

  it("sends what is new even for an episode that is already watched", async () => {
    saveState(sentUpTo());
    library = [series([1, 2], 2)];

    await onStreamRequest(account, "series", `${SHOW}:1:2`);

    expect(queued()).toEqual([expect.objectContaining({ episode: 2 })]);
    expect(callsTo("watch_restart")).toEqual([]);
  });

  it("sends nothing again for an episode already sent", async () => {
    saveState({ ...sentUpTo(), series: { [SHOW]: ["1:1", "1:2"] } });
    library = [series([1, 2], 3)];

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([]);
    expect(callsTo("watch_destination_list")).toEqual([]);
    expect(callsTo("watch_restart")).toHaveLength(1);
  });

  it("still starts the cycle when the send fails", async () => {
    recorded("queue_watch_writes", () => rpcError("queue is down"));
    const log = vi.spyOn(console, "error");
    saveState(sentUpTo());
    library = [series([1, 2], 3)];

    try {
      await onStreamRequest(account, "series", `${SHOW}:1:3`);

      expect(callsTo("queue_watch_writes")).toHaveLength(1);
      expect(callsTo("watch_restart")).toHaveLength(1);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("saves a baseline that Cinemeta cannot place any more, sending nothing", async () => {
    const unplaced: WatchState = {
      ...sentUpTo(),
      series: { [SHOW]: `${SHOW}:9:9:3:eJxjAAAAAQAB` },
    };
    saveState(unplaced);
    library = [series([1, 2], 3)];
    let conflicts = 1;
    r2Puts.before = (key) => {
      if (key !== stateKey() || conflicts === 0) return;
      conflicts -= 1;
      saveState({ ...unplaced, checkedAt: 99 });
    };

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([]);
    expect(callsTo("watch_destination_list")).toEqual([]);
    expect(conflicts).toBe(0);
    const state = await storedState();
    expect(state?.checkedAt).toBe(99);
    expect(state?.series[SHOW]).toEqual(["1:1", "1:2"]);
  });

  it("saves nothing when the Destinations cannot be read", async () => {
    recorded("watch_destination_list", () => rpcError("db is down"));
    const log = vi.spyOn(console, "error");
    const before = sentUpTo();
    saveState(before);
    library = [series([1, 2], 3)];

    try {
      await onStreamRequest(account, "series", `${SHOW}:1:3`);

      expect(await storedState()).toEqual(before);
      expect(callsTo("queue_watch_writes")).toEqual([]);
      expect(callsTo("watch_restart")).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("sends nothing before the Watched baseline", async () => {
    baselineContext(null);
    saveState(sentUpTo());
    library = [series([1, 2], 3)];

    await onStreamRequest(account, "series", `${SHOW}:1:3`);

    expect(queued()).toEqual([]);
    expect(callsTo("watch_restart")).toHaveLength(1);
  });
});
