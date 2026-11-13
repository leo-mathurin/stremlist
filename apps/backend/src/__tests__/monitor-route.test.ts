import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import app from "../index.js";
import { SourceUnavailableError } from "../providers/types";
import { resetConfigTest } from "./helpers/config-api.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { callRpc } from "./helpers/mock-supabase.js";
import {
  haltLetterboxdGate,
  letterboxdGate,
} from "./helpers/supabase/letterboxd-gate-rpcs.js";

const { backgroundMocks, prewarmMocks, supabaseMocks } = await vi.hoisted(
  () => import("./helpers/config-api-mocks.js"),
);
vi.mock("../lib/background", () => backgroundMocks);
vi.mock("../services/list-prewarm", () => prewarmMocks);
vi.mock("../lib/supabase", () => supabaseMocks);
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../providers/registry", () => import("./helpers/mock-registry.js"));
vi.mock("../lib/r2", () => import("./helpers/mock-r2.js"));
vi.mock("../lib/resend", () => import("./helpers/mock-resend.js"));

const IMDB_BEAT = "https://beat.example/imdb";
const LBX_BEAT = "https://beat.example/letterboxd";
const SECRET = "cron-secret";

function monitor(secret = SECRET) {
  return app.request("/monitor", {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

let beats: { url: string; method: string }[];
beforeEach(() => {
  resetConfigTest();
  resetProviders();
  for (const name of [
    "BETTERSTACK_HEARTBEAT_URL",
    "BETTERSTACK_HEARTBEAT_URL_IMDB",
    "BETTERSTACK_HEARTBEAT_URL_LETTERBOXD",
    "BETTERSTACK_HEARTBEAT_URL_JUSTWATCH",
    "BETTERSTACK_HEARTBEAT_URL_SENSCRITIQUE",
    "MONITOR_IMDB_USER_ID",
    "MONITOR_LETTERBOXD_REF",
    "MONITOR_JUSTWATCH_REF",
    "MONITOR_SENSCRITIQUE_REF",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("CRON_SECRET", SECRET);
  beats = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      beats.push({ url, method: init?.method ?? "GET" });
      return Promise.resolve(new Response("ok"));
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /monitor", () => {
  it("refuses a request without the cron secret", async () => {
    const res = await monitor("wrong");
    expect(res.status).toBe(401);
    expect(beats).toEqual([]);
  });

  it("fails loudly when no Provider monitor is configured", async () => {
    const res = await monitor();
    expect(res.status).toBe(500);
  });

  it("probes each configured Provider and reports to its own heartbeat", async () => {
    vi.stubEnv("MONITOR_IMDB_USER_ID", "ur12345678");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL", IMDB_BEAT);
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    const imdbRead = vi.fn(() =>
      Promise.resolve({ entries: [{ imdbId: "tt0111161" }], complete: true }),
    );
    const letterboxdRead = vi.fn(() =>
      Promise.reject(new SourceUnavailableError("disabled", "halted")),
    );
    useFakeProvider(fakeAdapter("imdb", { fetchSource: imdbRead }));
    useFakeProvider(fakeAdapter("letterboxd", { fetchSource: letterboxdRead }));

    const res = await monitor();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      results: [
        { provider: "imdb", ok: true, entries: 1 },
        { provider: "letterboxd", ok: false, error: "halted" },
      ],
    });
    expect(imdbRead).toHaveBeenCalledWith("ur12345678", {
      connection: null,
      forceRefresh: true,
    });
    // The Letterboxd probe defaults to Letterboxd's official Top 500 list.
    expect(letterboxdRead).toHaveBeenCalledWith(
      "users/official/lists/letterboxds-top-500-films",
      {
        connection: null,
        forceRefresh: true,
      },
    );
    expect(beats).toEqual(
      expect.arrayContaining([
        { url: IMDB_BEAT, method: "GET" },
        { url: `${LBX_BEAT}/fail`, method: "POST" },
      ]),
    );
    expect(beats).toHaveLength(2);
  });

  it("answers 200 when every configured probe works, and skips unconfigured ones", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    // JustWatch has a reference but no heartbeat: it is not probed.
    vi.stubEnv(
      "MONITOR_JUSTWATCH_REF",
      "tl-us-0f1e2d3c-4b5a-4968-8776-655443322110",
    );
    const justwatchRead = vi.fn();
    useFakeProvider(fakeAdapter("letterboxd"));
    useFakeProvider(fakeAdapter("justwatch", { fetchSource: justwatchRead }));

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(beats).toEqual([{ url: LBX_BEAT, method: "GET" }]);
    expect(justwatchRead).not.toHaveBeenCalled();
  });

  it("reports Letterboxd when 429 responses kept its rate below half for 30 minutes", async () => {
    vi.stubEnv(
      "MONITOR_LETTERBOXD_REF",
      "users/official/lists/letterboxds-top-500-films",
    );
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    const letterboxdRead = vi.fn();
    useFakeProvider(fakeAdapter("letterboxd", { fetchSource: letterboxdRead }));
    await callRpc("letterboxd_take_turn", {
      p_target: 10,
      p_priority: "first",
    });
    Object.assign(letterboxdGate() ?? {}, {
      rate: 2,
      slowSince: Date.now() - 31 * 60_000,
    });

    const res = await monitor();

    expect(res.status).toBe(502);
    expect(letterboxdRead).not.toHaveBeenCalled();
    expect(beats).toEqual([{ url: `${LBX_BEAT}/fail`, method: "POST" }]);
  });

  it("probes a halted Letterboxd once its recovery probe is due", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    const letterboxdRead = vi.fn(() =>
      Promise.resolve({ complete: true, entries: [] }),
    );
    useFakeProvider(fakeAdapter("letterboxd", { fetchSource: letterboxdRead }));
    haltLetterboxdGate();
    expect((await monitor()).status).toBe(502);
    expect(letterboxdRead).not.toHaveBeenCalled();

    Object.assign(letterboxdGate() ?? {}, { nextProbeAt: Date.now() - 1 });
    beats = [];
    expect((await monitor()).status).toBe(200);
    expect(letterboxdRead).toHaveBeenCalledTimes(1);
    expect(beats).toEqual([{ url: LBX_BEAT, method: "GET" }]);
  });

  it("never contacts a Provider turned off with the kill switch, and reports it", async () => {
    vi.stubEnv("DISABLED_PROVIDERS", "justwatch");
    vi.stubEnv(
      "MONITOR_JUSTWATCH_REF",
      "tl-us-0f1e2d3c-4b5a-4968-8776-655443322110",
    );
    vi.stubEnv(
      "BETTERSTACK_HEARTBEAT_URL_JUSTWATCH",
      "https://beat.example/jw",
    );
    const justwatchRead = vi.fn();
    useFakeProvider(fakeAdapter("justwatch", { fetchSource: justwatchRead }));

    const res = await monitor();

    expect(res.status).toBe(502);
    expect(justwatchRead).not.toHaveBeenCalled();
    expect(beats).toEqual([
      { url: "https://beat.example/jw/fail", method: "POST" },
    ]);
  });
});
