import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { z } from "zod";
import app from "../index.js";
import { HttpError } from "../providers/http";
import { LetterboxdBusyError } from "../providers/letterboxd-gate";
import { OUTAGE_STALE_MS } from "../providers/outages";
import { SourceUnavailableError } from "../providers/types";
import { resetConfigTest } from "./helpers/config-api.js";
import { readJson } from "./helpers/json.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { callRpc, db, rpcHandlers } from "./helpers/mock-supabase.js";
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
/** Status that the stubbed fetch answers per URL prefix; 200 otherwise. */
let statuses: Map<string, number>;
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
    "MONITOR_TRAKT_REF",
    "BETTERSTACK_HEARTBEAT_URL_TRAKT",
    "BETTERSTACK_HEARTBEAT_URL_SIMKL",
    "BETTERSTACK_HEARTBEAT_URL_MDBLIST",
    "TRAKT_CLIENT_ID",
    "SIMKL_CLIENT_ID",
    "MDBLIST_CLIENT_ID",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("CRON_SECRET", SECRET);
  // Letterboxd always has a reference; tests that probe it replace this.
  useFakeProvider(fakeAdapter("letterboxd"));
  beats = [];
  statuses = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      beats.push({ url, method: init?.method ?? "GET" });
      const status = [...statuses].find(([prefix]) =>
        url.startsWith(prefix),
      )?.[1];
      return Promise.resolve(new Response("ok", { status: status ?? 200 }));
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

  it("probes Letterboxd's default list even with no heartbeat", async () => {
    const letterboxdRead = vi.fn(() =>
      Promise.resolve({ entries: [], complete: true }),
    );
    useFakeProvider(fakeAdapter("letterboxd", { fetchSource: letterboxdRead }));

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(letterboxdRead).toHaveBeenCalledTimes(1);
    expect(beats).toEqual([]);
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
        {
          provider: "letterboxd",
          ok: false,
          outage: false,
          error: "halted",
        },
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

  it("answers 200 when every probe works, and skips Providers it cannot read", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    // JustWatch has a heartbeat but no reference: it is not probed.
    vi.stubEnv(
      "BETTERSTACK_HEARTBEAT_URL_JUSTWATCH",
      "https://beat.example/jw",
    );
    const justwatchRead = vi.fn();
    useFakeProvider(fakeAdapter("justwatch", { fetchSource: justwatchRead }));

    const res = await monitor();

    expect(res.status).toBe(200);
    // Trakt, Simkl and MDBList have no client ID here: no probe.
    expect(await res.json()).toEqual({
      ok: true,
      results: [{ provider: "letterboxd", ok: true, entries: 0 }],
    });
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

const providersBody = z.object({
  providers: z.array(
    z.object({ id: z.string(), outageSince: z.string().nullable() }),
  ),
});

/** The Providers that GET /providers reports with an outage. */
async function outages(): Promise<string[]> {
  const { providers } = await readJson(
    await app.request("/providers"),
    providersBody,
  );
  return providers
    .filter((provider) => provider.outageSince !== null)
    .map((provider) => provider.id);
}

function failingRead(error: unknown) {
  return vi.fn(() => Promise.reject(error));
}

describe("Provider outages", () => {
  it("probes Trakt's public chart and the Simkl and MDBList APIs once their apps are set", async () => {
    vi.stubEnv("TRAKT_CLIENT_ID", "trakt-app");
    vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
    vi.stubEnv("MDBLIST_CLIENT_ID", "mdblist-app");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_TRAKT", "https://beat.example/trakt");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_SIMKL", "https://beat.example/simkl");
    // MDBList answers 401 without a user token: its API is up.
    statuses.set("https://api.mdblist.com/", 401);
    const traktRead = vi.fn(() =>
      Promise.resolve({ entries: [{ imdbId: "tt0111161" }], complete: true }),
    );
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: traktRead,
        oauth: {
          authorizeUrl: "",
          tokenUrl: "",
          clientId: () => "trakt-app",
        },
      }),
    );

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(traktRead).toHaveBeenCalledWith("trending", {
      connection: null,
      forceRefresh: true,
    });
    const urls = beats.map((beat) => beat.url);
    expect(urls).toContain(
      "https://api.simkl.com/search/id?imdb=tt0111161&client_id=simkl-app",
    );
    expect(urls).toContain("https://api.mdblist.com/lists/top");
    expect(urls).toContain("https://beat.example/trakt");
    expect(urls).toContain("https://beat.example/simkl");
  });

  it("shows an outage after two failed probes in a row, and ends it on the next success", async () => {
    vi.stubEnv("MONITOR_JUSTWATCH_REF", "tl-us-list");
    const justwatch = useFakeProvider(
      fakeAdapter("justwatch", {
        fetchSource: failingRead(
          new HttpError(503, "", "https://apis.justwatch.com/"),
        ),
      }),
    );

    await monitor();
    expect(await outages()).toEqual([]);

    const res = await monitor();
    const { results } = await readJson(
      res,
      z.object({
        results: z.array(
          z.object({ provider: z.string(), outage: z.boolean().optional() }),
        ),
      }),
    );
    expect(results.find((r) => r.provider === "justwatch")?.outage).toBe(true);
    expect(await outages()).toEqual(["justwatch"]);

    justwatch.fetchSource = () =>
      Promise.resolve({ entries: [], complete: true });
    await monitor();
    expect(await outages()).toEqual([]);
  });

  it("reports several Providers at once, each recovering on its own", async () => {
    vi.stubEnv("MONITOR_JUSTWATCH_REF", "tl-us-list");
    vi.stubEnv("MONITOR_SENSCRITIQUE_REF", "users/x/wishes");
    vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
    statuses.set("https://api.simkl.com/", 502);
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const network = Object.assign(new TypeError("Unable to connect"), {
      code: "ECONNREFUSED",
    });
    useFakeProvider(
      fakeAdapter("justwatch", { fetchSource: failingRead(timeout) }),
    );
    const senscritique = useFakeProvider(
      fakeAdapter("senscritique", { fetchSource: failingRead(network) }),
    );

    await monitor();
    await monitor();
    expect(await outages()).toEqual(["simkl", "justwatch", "senscritique"]);

    senscritique.fetchSource = () =>
      Promise.resolve({ entries: [], complete: true });
    statuses.delete("https://api.simkl.com/");
    await monitor();
    expect(await outages()).toEqual(["justwatch"]);
  });

  it.each([
    [
      "a private monitor list",
      new SourceUnavailableError("private", "private"),
    ],
    ["a missing monitor list", new SourceUnavailableError("not_found", "gone")],
    [
      "a refused Connection",
      new SourceUnavailableError("needs_connection", "expired"),
    ],
    [
      "a Provider app that is not configured",
      new SourceUnavailableError("disabled", "Trakt is not configured"),
    ],
    ["a rate limit", new HttpError(429, "", "https://apis.justwatch.com/")],
    ["a busy queue", new LetterboxdBusyError(60_000)],
    ["a response Stremlist cannot read", new Error("Unexpected token <")],
    [
      "an unavailable read without a Provider failure behind it",
      new SourceUnavailableError("unavailable", "Simkl is not configured"),
    ],
    ["a bug in Stremlist", new TypeError("x is undefined")],
  ])("never reports an outage for %s", async (_name, error) => {
    vi.stubEnv("MONITOR_JUSTWATCH_REF", "tl-us-list");
    useFakeProvider(
      fakeAdapter("justwatch", { fetchSource: failingRead(error) }),
    );

    for (let run = 0; run < 3; run++) {
      // The failure still alerts: the probe is not ok.
      expect((await monitor()).status).toBe(502);
    }
    expect(await outages()).toEqual([]);
  });

  it("never reports an outage for a Simkl rate limit", async () => {
    vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
    statuses.set("https://api.simkl.com/", 429);
    await monitor();
    await monitor();
    expect(await outages()).toEqual([]);
  });

  it("keeps an outage through an inconclusive probe", async () => {
    vi.stubEnv("MONITOR_JUSTWATCH_REF", "tl-us-list");
    const justwatch = useFakeProvider(
      fakeAdapter("justwatch", {
        fetchSource: failingRead(
          new SourceUnavailableError("unavailable", "did not answer", {
            cause: new HttpError(503, "", "https://apis.justwatch.com/"),
          }),
        ),
      }),
    );
    await monitor();
    await monitor();
    justwatch.fetchSource = failingRead(
      new HttpError(429, "", "https://apis.justwatch.com/"),
    );
    await monitor();
    expect(await outages()).toEqual(["justwatch"]);
  });

  describe("through the real adapters", () => {
    beforeEach(() => {
      // The real Letterboxd adapter, not the fake from the outer setup.
      resetProviders();
    });

    it("reports an IMDb outage when IMDb answers 5xx", async () => {
      vi.stubEnv("MONITOR_IMDB_USER_ID", "ur12345678");
      statuses.set("https://api.graphql.imdb.com/", 503);
      statuses.set("https://letterboxd.com/", 404);
      await monitor();
      await monitor();
      expect(await outages()).toContain("imdb");
    });

    it("reports a Letterboxd outage when Letterboxd answers 5xx", async () => {
      statuses.set("https://letterboxd.com/", 502);
      await monitor();
      await monitor();
      expect(await outages()).toEqual(["letterboxd"]);
    });

    it.each([
      [
        "a Cloudflare error page",
        502,
        '<div class="cf-error-details">Bad gateway</div>',
        {},
      ],
      ["no body", 503, null, {}],
      ["a Cloudflare challenge", 503, null, { "cf-mitigated": "challenge" }],
    ])(
      "reports a Letterboxd outage for a 5xx answer with %s",
      async (_name, status, body, headers: Record<string, string>) => {
        vi.stubGlobal(
          "fetch",
          vi.fn((url: string) =>
            Promise.resolve(
              url.startsWith("https://letterboxd.com/")
                ? new Response(body, { status, headers })
                : new Response("ok"),
            ),
          ),
        );
        await monitor();
        await monitor();
        expect(await outages()).toEqual(["letterboxd"]);
      },
    );

    it("reports no Letterboxd outage for a page it cannot read", async () => {
      // HTTP 200 whose markup is not a list page.
      await monitor();
      await monitor();
      expect(await outages()).toEqual([]);
    });

    it("reports no Letterboxd outage when its gate cannot be read", async () => {
      rpcHandlers.set("letterboxd_take_turn", () => ({
        data: null,
        error: { message: "database down" },
      }));
      await monitor();
      await monitor();
      expect(await outages()).toEqual([]);
    });
  });

  it("hides an outage once the monitor has not checked for an hour", async () => {
    db.getTable("provider_outages").push({
      provider: "trakt",
      failures: 4,
      outage_since: new Date(Date.now() - 2 * OUTAGE_STALE_MS).toISOString(),
      checked_at: new Date(Date.now() - OUTAGE_STALE_MS - 1000).toISOString(),
    });
    expect(await outages()).toEqual([]);
  });

  it("shows a turned-off Provider as unavailable, not as an outage", async () => {
    db.getTable("provider_outages").push({
      provider: "justwatch",
      failures: 2,
      outage_since: new Date().toISOString(),
      checked_at: new Date().toISOString(),
    });
    expect(await outages()).toEqual(["justwatch"]);
    vi.stubEnv("DISABLED_PROVIDERS", "justwatch");
    expect(await outages()).toEqual([]);
  });

  it("reports no outage when the outages cannot be read", async () => {
    db.getTable("provider_outages").push({
      provider: "trakt",
      failures: 2,
      outage_since: new Date().toISOString(),
      checked_at: new Date().toISOString(),
    });
    vi.spyOn(supabaseMocks.supabase, "from").mockImplementation(() => {
      throw new Error("database down");
    });
    const res = await app.request("/providers");
    expect(res.status).toBe(200);
    expect(await outages()).toEqual([]);
  });
});
