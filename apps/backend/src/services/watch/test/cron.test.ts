import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { seedConnection } from "../../../test/helpers/account.fixture";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import {
  db,
  resetRpc,
  rpcCallsOf,
  rpcHandlers,
} from "../../../test/helpers/mock-supabase";
import { rpcError } from "../../../test/helpers/supabase/rpc";
import { runWatchCron } from "../cron";

const server = useMswServer();

interface Heartbeat {
  url: string;
  method: string;
  body: string;
}

const heartbeats: Heartbeat[] = [];

beforeEach(() => {
  heartbeats.length = 0;
  resetRpc();
  for (const name of [
    "claim_watch_reads",
    "claim_watch_writes",
    "claim_sweep_slots",
  ]) {
    rpcHandlers.set(name, () => ({ data: [], error: null }));
  }
  rpcHandlers.set("watch_simkl_backlog", () => ({ data: 0, error: null }));
  rpcHandlers.set("take_simkl_slots", () =>
    rpcError("canceling statement due to lock timeout"),
  );
  server.use(
    http.all("https://uptime.betterstack.com/*", async ({ request }) => {
      heartbeats.push({
        url: request.url,
        method: request.method,
        body: await request.text(),
      });
      return new HttpResponse(null, { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRpc();
});

describe("the Watch tracking cron", () => {
  it("claims queued writes while native reads are still running", async () => {
    const released = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    let readsPending = true;
    let writesClaimedDuringRead = false;
    rpcHandlers.set("claim_watch_reads", async () => {
      reading.resolve();
      await released.promise;
      return { data: [], error: null };
    });
    rpcHandlers.set("claim_watch_writes", () => {
      writesClaimedDuringRead = readsPending;
      writing.resolve();
      return { data: [], error: null };
    });
    const running = runWatchCron();
    try {
      await reading.promise;
      await writing.promise;
      expect(writesClaimedDuringRead).toBe(true);
    } finally {
      readsPending = false;
      released.resolve();
      await running;
    }
  });

  it("reports the message of a Supabase error to Better Stack", async () => {
    const heartbeat = "https://uptime.betterstack.com/api/v1/heartbeat/watch";
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_WATCH", heartbeat);

    const report = await runWatchCron();

    expect(report.errors).toEqual([
      "simkl writes: canceling statement due to lock timeout",
    ]);
    expect(heartbeats).toEqual([
      {
        url: `${heartbeat}/fail`,
        method: "POST",
        body: "simkl writes: canceling statement due to lock timeout",
      },
    ]);
  });

  it("does not fail the heartbeat for Titles that the Destination does not know", async () => {
    const heartbeat = "https://uptime.betterstack.com/api/v1/heartbeat/watch";
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_WATCH", heartbeat);
    vi.stubEnv("MDBLIST_CLIENT_ID", "mdblist-app");
    rpcHandlers.set("take_simkl_slots", () => ({ data: [], error: null }));
    seedConnection("sl_watcher", "mdblist");
    let claimed = false;
    rpcHandlers.set("claim_watch_writes", (args) => {
      if (claimed || args.p_provider !== "simkl" || !args.p_exclude)
        return { data: [], error: null };
      claimed = true;
      const rows = Array.from({ length: 105 }, (_, index) => ({
        id: index + 1,
        kind: "watched",
        account_id: "sl_watcher",
        provider: "mdblist",
        imdb_id: "tt4644488",
        item_type: "series",
        season: 1,
        episode: index + 1,
        watched_at: "2026-11-24T20:40:00.000Z",
        attempts: 0,
        first_failed_at: null,
        uncertain: false,
      }));
      for (const row of rows)
        db.getTable("watch_writes").push({
          ...row,
          lease_token: args.p_lease_token,
        });
      return { data: rows, error: null };
    });
    rpcHandlers.set("finish_watch_writes", () => ({ data: null, error: null }));
    server.use(
      http.post("https://api.mdblist.com/sync/watched", () =>
        HttpResponse.json({ not_found: { shows: 1 } }),
      ),
    );

    const report = await runWatchCron();

    expect(report.writes).toMatchObject({ sent: 0, failed: 0, gaveUp: 105 });
    expect(rpcCallsOf("finish_watch_writes")).toMatchObject([
      {
        p_rows: Array.from({ length: 105 }, () => ({
          done: false,
          error: "not_found",
        })),
      },
    ]);
    expect(heartbeats).toEqual([{ url: heartbeat, method: "GET", body: "" }]);
  });
});
