import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runWatchCron } from "../cron";

vi.mock("../reads", () => ({ processReads: () => Promise.resolve(undefined) }));
vi.mock("../sweep", () => ({ processSweep: () => Promise.resolve(undefined) }));
vi.mock("../writes", () => ({
  SIMKL_BACKLOG_ALERT_SECONDS: 600,
  simklBacklogSeconds: () => Promise.resolve(0),
  processWrites: () => Promise.resolve(undefined),
  processSimklWrites: () =>
    Promise.reject({ message: "canceling statement due to lock timeout" }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Watch tracking cron", () => {
  it("reports the message of a Supabase error to Better Stack", async () => {
    const heartbeat = "https://uptime.betterstack.com/api/v1/heartbeat/watch";
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_WATCH", heartbeat);
    const fetch = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", fetch);

    const report = await runWatchCron();

    expect(report.errors).toEqual([
      "simkl writes: canceling statement due to lock timeout",
    ]);
    expect(fetch).toHaveBeenCalledWith(`${heartbeat}/fail`, {
      method: "POST",
      body: "simkl writes: canceling statement due to lock timeout",
    });
  });
});
