import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { resetRpc, rpcHandlers } from "../../../test/helpers/mock-supabase";
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
});
