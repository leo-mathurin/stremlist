import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { z } from "zod";
import app from "../index.js";
import { OUTAGE_STALE_MS } from "../providers/outages";
import { movie, seedConnection } from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { resetConfigTest } from "./helpers/config-api.js";
import {
  FakeImdb,
  IMDB_GRAPHQL,
  imdbTitle,
} from "./helpers/imdb.test-utils.js";
import { readJson } from "./helpers/json.js";
import { letterboxdPage } from "./helpers/letterboxd.test-utils.js";
import { callRpc, db } from "./helpers/mock-supabase.js";
import { unexpectedRequest, useMswServer } from "./helpers/msw.test-utils.js";
import {
  haltLetterboxdGate,
  letterboxdGate,
} from "./helpers/supabase/letterboxd-gate-rpcs.js";

const IMDB_BEAT = "https://beat.example/imdb";
const LBX_BEAT = "https://beat.example/letterboxd";
const SECRET = "cron-secret";
const SUPABASE_REST = new URL("/rest/v1/", process.env.SUPABASE_URL).href;
const OFFICIAL_LIST =
  "https://letterboxd.com/official/list/letterboxds-top-500-films/";
const JUSTWATCH_GRAPHQL = "https://apis.justwatch.com/graphql";
const SENSCRITIQUE_GRAPHQL = "https://apollo.senscritique.com/";
const TRAKT_API = "https://api.trakt.tv";

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();

const probeOutcome = z.discriminatedUnion("ok", [
  z.object({ provider: z.enum(PROVIDER_IDS), ok: z.literal(true) }),
  z.object({
    provider: z.enum(PROVIDER_IDS),
    ok: z.literal(false),
    error: z.string(),
  }),
]);

const monitorAnswer = z
  .object({
    results: z.array(probeOutcome),
    listChecks: z.object({ started: z.boolean() }),
  })
  .partial();

let listCheckRuns = 0;
let answered = Promise.withResolvers<void>();

function listCheckHold() {
  return http.patch(`${SUPABASE_REST}monitor_runs`, async () => {
    listCheckRuns += 1;
    await answered.promise;
  });
}

async function monitor(secret = SECRET) {
  answered = Promise.withResolvers<void>();
  let res: Response;
  try {
    res = await app.request("/monitor", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    await readJson(res.clone(), monitorAnswer);
  } finally {
    answered.resolve();
  }
  await background.settle();
  return res;
}

function endListCheckInterval() {
  db.getTable("monitor_runs").length = 0;
}

function tick() {
  vi.setSystemTime(Date.now() + 1_000);
}

function statusOf(url: string) {
  return [...statuses].find(([prefix]) => url.startsWith(prefix))?.[1];
}

const TITLES = Array.from({ length: 250 }, (_, index) =>
  imdbTitle(movie(`tt${String(1_000_000 + index)}`)),
);

const imdbBody = z.object({ operationName: z.string() }).loose();

function imdbWorld() {
  return http.post(IMDB_GRAPHQL, async ({ request }) => {
    tick();
    const status = statusOf(request.url);
    if (status) return new HttpResponse(null, { status });
    const { operationName } = imdbBody.parse(await request.clone().json());
    const page = { hasNextPage: false, endCursor: null };
    switch (operationName) {
      case "ChartTitles":
        return HttpResponse.json({
          data: {
            chartTitles: {
              edges: TITLES.map((node) => ({ node })),
              pageInfo: page,
            },
          },
        });
      case "BoxOffice":
        return HttpResponse.json({
          data: {
            topGrossingReleases: {
              edges: TITLES.slice(0, 10).map((title) => ({
                node: { release: { titles: [title] } },
              })),
            },
          },
        });
      case "ComingSoon":
        return HttpResponse.json({
          data: { comingSoon: { edges: TITLES.map((node) => ({ node })) } },
        });
      case "UserRatings":
        return HttpResponse.json({
          data: {
            advancedTitleSearch: {
              total: TITLES.length,
              pageInfo: page,
              edges: TITLES.map((title) => ({
                node: {
                  title: { ...title, userRating: { date: "2026-01-01" } },
                },
              })),
            },
          },
        });
      default:
        return imdb.answer(request);
    }
  });
}

type Answer = (request: Request) => Response | Promise<Response>;

const healthyLetterboxd: Answer = (request) =>
  request.url === OFFICIAL_LIST
    ? new HttpResponse(
        letterboxdPage(Array.from({ length: 450 }, (_, index) => index + 1)),
      )
    : unexpectedRequest(request);

function justwatchList(titles: number) {
  return HttpResponse.json({
    data: {
      node: {
        __typename: "GenericTitleList",
        id: "tl-us-list",
        type: "USER_LIST",
        visibility: "PUBLIC",
        name: "Monitor",
        content: { name: "Monitor" },
        titles: {
          totalCount: titles,
          pageInfo: { hasNextPage: false, endCursor: "" },
          edges: Array.from({ length: titles }, (_, index) => ({
            node: {
              id: `tm${index + 1}`,
              objectType: "MOVIE",
              content: {
                title: `Movie ${index + 1}`,
                originalReleaseYear: 2000,
                externalIds: { imdbId: `tt${2_000_000 + index}`, tmdbId: null },
              },
            },
          })),
        },
      },
    },
  });
}

let beats: { url: string; method: string }[];
let failBodies: Map<string, string>;
let statuses: Map<string, number>;
let pages: Map<string, unknown>;
let requests: string[];
let letterboxd: Answer;
let justwatch: Answer;
let senscritique: Answer;
let simklTrending: Map<string, number>;

function worldHandlers() {
  const own = new Set(
    [process.env.SUPABASE_URL, process.env.R2_ENDPOINT].map(
      (url) => new URL(url ?? "http://localhost").host,
    ),
  );
  server.events.on("request:start", ({ request }) => {
    if (!own.has(new URL(request.url).host)) requests.push(request.url);
  });
  return [
    http.all("https://beat.example/*", async ({ request }) => {
      beats.push({ url: request.url, method: request.method });
      if (request.method === "POST") {
        failBodies.set(request.url, await request.text());
      }
      return new HttpResponse("ok", { status: statusOf(request.url) ?? 200 });
    }),
    http.get(
      /^https:\/\/(status\.(trakt\.tv|simkl\.com|mdblist\.com)|senscritique\.instatus\.com)\//,
      ({ request }) => {
        const page = [...pages].find(([prefix]) =>
          request.url.startsWith(prefix),
        );
        if (page) {
          return new HttpResponse(JSON.stringify(page[1]), {
            headers: { "Content-Type": "application/json" },
          });
        }
        const status = statusOf(request.url);
        return status
          ? new HttpResponse("", { status })
          : unexpectedRequest(request);
      },
    ),
    imdbWorld(),
    http.get("https://letterboxd.com/*", ({ request }) => {
      tick();
      const status = statusOf(request.url);
      return status ? new HttpResponse(null, { status }) : letterboxd(request);
    }),
    http.post(JUSTWATCH_GRAPHQL, ({ request }) => {
      tick();
      return justwatch(request);
    }),
    http.post(SENSCRITIQUE_GRAPHQL, ({ request }) => {
      tick();
      return senscritique(request);
    }),
    http.get(`${TRAKT_API}/*`, ({ request }) => {
      tick();
      const status = statusOf(request.url);
      if (status) return new HttpResponse(null, { status });
      const path = new URL(request.url).pathname;
      const calendar = /^\/calendars\/all\/(shows|movies|dvd)\//.exec(path);
      if (calendar) {
        return HttpResponse.json(
          Array.from({ length: 30 }, (_, index) => {
            const media = {
              title: `Title ${index}`,
              ids: { trakt: index + 1, imdb: `tt${5_000_000 + index}` },
            };
            return calendar[1] === "shows"
              ? { first_aired: "2026-12-01T02:00:00.000Z", show: media }
              : { released: "2026-12-01", movie: media };
          }),
        );
      }
      if (!/^\/(movies|shows)\//.test(path)) return unexpectedRequest(request);
      return HttpResponse.json(
        Array.from({ length: 30 }, (_, index) => ({
          title: `Title ${index}`,
          ids: { trakt: index + 1, imdb: `tt${3_000_000 + index}` },
        })),
      );
    }),
    http.get("https://api.simkl.com/*", ({ request }) => {
      tick();
      return HttpResponse.json([], { status: statusOf(request.url) ?? 200 });
    }),
    http.get("https://data.simkl.in/discover/*", ({ request }) => {
      tick();
      const file = new URL(request.url).pathname.replace(/^\/discover\//, "");
      const size = Number(/_(\d+)\.json$/.exec(file)?.[1] ?? 0);
      return HttpResponse.json(
        Array.from({ length: simklTrending.get(file) ?? size }, (_, index) => ({
          title: `Title ${index}`,
          ids: { simkl: index + 1, imdb: `tt${4_000_000 + index}` },
        })),
      );
    }),
    http.get("https://api.mdblist.com/*", ({ request }) => {
      tick();
      return HttpResponse.json({}, { status: statusOf(request.url) ?? 200 });
    }),
  ];
}

const STATUS_PAGES = [
  "https://status.trakt.tv/",
  "https://status.simkl.com/",
  "https://status.mdblist.com/",
  "https://senscritique.instatus.com/",
];

const NO_PAGES = {
  trakt: null,
  simkl: null,
  mdblist: null,
  senscritique: null,
};

let now = Date.parse("2026-11-01T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 24 * 60 * 60_000;
  vi.setSystemTime(now);
  resetConfigTest();
  imdb.reset();
  listCheckRuns = 0;
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
    "MONITOR_ACCOUNT_ID",
    "MONITOR_CANARY_REFS",
    "BETTERSTACK_HEARTBEAT_URL_TRAKT",
    "BETTERSTACK_HEARTBEAT_URL_SIMKL",
    "BETTERSTACK_HEARTBEAT_URL_MDBLIST",
    "TRAKT_CLIENT_ID",
    "SIMKL_CLIENT_ID",
    "MDBLIST_CLIENT_ID",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("CRON_SECRET", SECRET);
  beats = [];
  failBodies = new Map();
  statuses = new Map(STATUS_PAGES.map((page) => [page, 503]));
  pages = new Map();
  requests = [];
  letterboxd = healthyLetterboxd;
  justwatch = () => justwatchList(5);
  senscritique = () =>
    HttpResponse.json({ errors: [{ message: "Unknown query" }] });
  simklTrending = new Map();
  imdb.watchlists.set("ur12345678", [movie("tt0111161")]);
  imdb.watchlists.set(
    "ur195879360",
    Array.from({ length: 70 }, (_, index) =>
      movie(`tt${String(5_000_000 + index)}`),
    ),
  );
  imdb.lists.set(
    "ls055592025",
    Array.from({ length: 90 }, (_, index) =>
      movie(`tt${String(6_000_000 + index)}`),
    ),
  );
  server.events.removeAllListeners("request:start");
  server.use(listCheckHold(), ...worldHandlers());
  vi.spyOn(console, "error");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /monitor", () => {
  it("refuses a request without the cron secret", async () => {
    const res = await monitor("wrong");
    expect(res.status).toBe(401);
    expect(beats).toEqual([]);
  });

  it("probes Letterboxd's default list even with no heartbeat", async () => {
    const res = await monitor();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      results: [{ provider: "letterboxd", ok: true, entries: 450 }],
    });
    expect(requests.filter((url) => url === OFFICIAL_LIST)).toEqual([
      OFFICIAL_LIST,
      OFFICIAL_LIST,
    ]);
    expect(beats).toEqual([]);
  });

  it("probes each configured Provider and reports to its own heartbeat", async () => {
    vi.stubEnv("MONITOR_IMDB_USER_ID", "ur12345678");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL", IMDB_BEAT);
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    letterboxd = () => new HttpResponse(null, { status: 404 });

    const res = await monitor();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      results: [
        { provider: "imdb", ok: true, entries: 1 },
        {
          provider: "letterboxd",
          ok: false,
          outage: false,
          error: "Letterboxd could not read this public list",
        },
      ],
      statusPages: NO_PAGES,
      listChecks: {
        started: true,
        last: { finishedAt: null },
      },
    });
    expect(
      imdb
        .requestsOf("WatchListPage")
        .map(({ variables }) => variables.urConst),
    ).toContain("ur12345678");
    expect(requests).toContain(OFFICIAL_LIST);
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
    vi.stubEnv(
      "BETTERSTACK_HEARTBEAT_URL_JUSTWATCH",
      "https://beat.example/jw",
    );

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      results: [{ provider: "letterboxd", ok: true, entries: 450 }],
      statusPages: NO_PAGES,
      listChecks: {
        started: true,
        last: { finishedAt: null },
      },
    });
    expect(beats).toEqual(
      expect.arrayContaining([
        { url: LBX_BEAT, method: "GET" },
        { url: "https://beat.example/jw", method: "GET" },
      ]),
    );
    expect(beats).toHaveLength(2);
    expect(
      requests.filter((url) => url.startsWith(JUSTWATCH_GRAPHQL)),
    ).toHaveLength(1);
  });

  it("reports Letterboxd when 429 responses kept its rate below half for 30 minutes", async () => {
    vi.stubEnv(
      "MONITOR_LETTERBOXD_REF",
      "users/official/lists/letterboxds-top-500-films",
    );
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
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
    expect(
      requests.filter((url) => url.startsWith("https://letterboxd.com/")),
    ).toEqual([]);
    expect(beats).toEqual([{ url: `${LBX_BEAT}/fail`, method: "POST" }]);
  });

  it("does not report Letterboxd as slow while its rate climbs back after a halt", async () => {
    vi.stubEnv("LETTERBOXD_MAX_RPS", "40");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    const report = (probe: boolean) =>
      callRpc("letterboxd_report", {
        p_target: 40,
        p_outcome: "ok",
        p_retry_after_ms: 0,
        p_probe: probe,
      });
    haltLetterboxdGate();
    await report(true);
    await report(false);
    expect(letterboxdGate()?.rate).toBe(0.33);
    vi.setSystemTime(Date.now() + 10_000);
    expect((await monitor()).status).toBe(200);

    vi.setSystemTime(Date.now() + 31 * 60_000);
    endListCheckInterval();
    beats = [];
    expect((await monitor()).status).toBe(200);
    await report(false);
    expect(letterboxdGate()?.rate).toBeLessThan(20);
    expect(beats).toEqual([{ url: LBX_BEAT, method: "GET" }]);
  });

  it("probes a halted Letterboxd once its recovery probe is due", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    haltLetterboxdGate();
    expect((await monitor()).status).toBe(200);
    expect(requests.filter((url) => url === OFFICIAL_LIST)).toEqual([]);
    expect(beats).toEqual([{ url: `${LBX_BEAT}/fail`, method: "POST" }]);

    Object.assign(letterboxdGate() ?? {}, { nextProbeAt: Date.now() - 1 });
    endListCheckInterval();
    beats = [];
    requests = [];
    expect((await monitor()).status).toBe(200);
    expect(requests.filter((url) => url === OFFICIAL_LIST)).toEqual([
      OFFICIAL_LIST,
      OFFICIAL_LIST,
    ]);
    expect(letterboxdGate()?.haltedAt).toBeNull();
    expect(beats).toEqual([
      { url: LBX_BEAT, method: "GET" },
      { url: LBX_BEAT, method: "GET" },
    ]);
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

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      results: [
        { provider: "letterboxd", ok: true },
        { provider: "justwatch", ok: false, unavailable: true },
      ],
    });
    expect(requests.filter((url) => url.startsWith(JUSTWATCH_GRAPHQL))).toEqual(
      [],
    );
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

async function outages() {
  const { providers } = await readJson(
    await app.request("/providers"),
    providersBody,
  );
  return providers
    .filter((provider) => provider.outageSince !== null)
    .map((provider) => provider.id);
}

describe("Provider outages", () => {
  it("probes Trakt's public chart and the Simkl and MDBList APIs once their apps are set", async () => {
    vi.stubEnv("TRAKT_CLIENT_ID", "trakt-app");
    vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
    vi.stubEnv("MDBLIST_CLIENT_ID", "mdblist-app");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_TRAKT", "https://beat.example/trakt");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_SIMKL", "https://beat.example/simkl");
    statuses.set("https://api.mdblist.com/", 401);

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      results: expect.arrayContaining([
        { provider: "trakt", ok: true, entries: 60 },
      ]) as unknown,
    });
    expect(requests).toContain(`${TRAKT_API}/movies/trending?limit=100`);
    expect(requests).toContain(
      "https://api.simkl.com/search/id?imdb=tt0111161&client_id=simkl-app",
    );
    expect(requests).toContain("https://api.mdblist.com/lists/top");
    const urls = beats.map((beat) => beat.url);
    expect(urls).toContain("https://beat.example/trakt");
    expect(urls).toContain("https://beat.example/simkl");
  });

  it("shows an outage after two failed probes in a row, and ends it on the next success", async () => {
    vi.stubEnv("MONITOR_JUSTWATCH_REF", "tl-us-list");
    justwatch = () => new HttpResponse(null, { status: 503 });

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

    justwatch = () => justwatchList(5);
    await monitor();
    expect(await outages()).toEqual([]);
  });

  it("reports several Providers at once, each recovering on its own", async () => {
    vi.stubEnv("MONITOR_JUSTWATCH_REF", "tl-us-list");
    vi.stubEnv("MONITOR_SENSCRITIQUE_REF", "top111-movies");
    vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
    statuses.set("https://api.simkl.com/", 502);
    justwatch = () => new HttpResponse(null, { status: 504 });
    senscritique = () => HttpResponse.error();

    await monitor();
    await monitor();
    expect(await outages()).toEqual(["simkl", "justwatch", "senscritique"]);

    senscritique = () => HttpResponse.json({ data: { top: [] } });
    statuses.delete("https://api.simkl.com/");
    await monitor();
    expect(await outages()).toEqual(["justwatch"]);
  });

  const JUSTWATCH_PROBE = { MONITOR_JUSTWATCH_REF: "tl-us-list" };

  it.each<[string, Record<string, string>, () => void]>([
    [
      "a private monitor list",
      JUSTWATCH_PROBE,
      () => {
        justwatch = () =>
          HttpResponse.json({
            errors: [{ message: "permission denied" }],
            data: { node: null },
          });
      },
    ],
    [
      "a missing monitor list",
      JUSTWATCH_PROBE,
      () => {
        justwatch = () => HttpResponse.json({ data: { node: null } });
      },
    ],
    [
      "a refused Connection",
      { TRAKT_CLIENT_ID: "trakt-app", MONITOR_TRAKT_REF: "me/watchlist" },
      () => undefined,
    ],
    [
      "a GraphQL error that names no outage",
      JUSTWATCH_PROBE,
      () => {
        justwatch = () =>
          HttpResponse.json({ errors: [{ message: "internal" }] });
      },
    ],
    [
      "a rate limit",
      JUSTWATCH_PROBE,
      () => {
        justwatch = () => new HttpResponse(null, { status: 429 });
      },
    ],
    [
      "a busy queue",
      {},
      () => {
        void callRpc("letterboxd_report", {
          p_target: 10,
          p_outcome: "rate_limited",
          p_retry_after_ms: 10 * 60_000,
          p_probe: false,
        });
      },
    ],
    [
      "a response Stremlist cannot read",
      JUSTWATCH_PROBE,
      () => {
        justwatch = () => HttpResponse.html("<html>Maintenance</html>");
      },
    ],
    [
      "an unavailable read without a Provider failure behind it",
      {},
      () => {
        letterboxd = () => HttpResponse.html("<html>No list here</html>");
      },
    ],
    [
      "an answer in a shape Stremlist does not know",
      JUSTWATCH_PROBE,
      () => {
        justwatch = () =>
          HttpResponse.json({ data: { node: { titles: "changed" } } });
      },
    ],
  ])("never reports an outage for %s", async (_name, env, fail) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    fail();

    for (let run = 0; run < 3; run++) {
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
    justwatch = () => new HttpResponse(null, { status: 503 });
    await monitor();
    await monitor();
    justwatch = () => new HttpResponse(null, { status: 429 });
    await monitor();
    expect(await outages()).toEqual(["justwatch"]);
  });

  describe("through the real adapters", () => {
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

    const letterboxdProbe = z.object({
      results: z.array(
        z.object({ provider: z.string(), outage: z.boolean().optional() }),
      ),
    });

    it.each([
      [
        "a Cloudflare error page",
        502,
        '<div class="cf-error-details">Bad gateway</div>',
        {},
        true,
      ],
      ["no body", 503, null, {}, false],
      [
        "a Cloudflare challenge",
        503,
        null,
        { "cf-mitigated": "challenge" },
        true,
      ],
    ])(
      "reports a Letterboxd outage for a 5xx answer with %s",
      async (_name, status, body, headers: Record<string, string>, halts) => {
        letterboxd = () => new HttpResponse(body, { status, headers });
        const { results } = await readJson(await monitor(), letterboxdProbe);
        expect(
          results.find((result) => result.provider === "letterboxd")?.outage,
        ).toBe(true);
        expect(
          db.getTable("provider_outages").map(({ provider, failures }) => ({
            provider,
            failures,
          })),
        ).toEqual([{ provider: "letterboxd", failures: 1 }]);
        expect(letterboxdGate()?.haltedAt ?? null).toBeNull();
        await monitor();
        expect(letterboxdGate()?.haltedAt != null).toBe(halts);
        expect(await outages()).toEqual(halts ? [] : ["letterboxd"]);
      },
    );

    it("reports no Letterboxd outage for a page it cannot read", async () => {
      letterboxd = () => HttpResponse.html("<html>No list here</html>");
      await monitor();
      await monitor();
      expect(await outages()).toEqual([]);
    });

    it("reports no Letterboxd outage when its gate cannot be read", async () => {
      server.use(
        http.post(`${SUPABASE_REST}rpc/letterboxd_take_turn`, () =>
          HttpResponse.json({ message: "database down" }, { status: 500 }),
        ),
      );
      await monitor();
      await monitor();
      expect(await outages()).toEqual([]);
    });
  });

  describe("official status pages", () => {
    const traktPage = (statusClass: string) => ({
      psp: {
        monitors: [
          { name: "Trending", statusClass, groupName: "API" },
          { name: "Web App", statusClass: "success", groupName: "Web" },
        ],
      },
    });

    it("starts an outage at once when the status page says the API is down", async () => {
      pages.set("https://status.trakt.tv/", traktPage("danger"));
      const res = await monitor();
      expect(await outages()).toEqual(["trakt"]);
      expect(res.status).toBe(200);
    });

    it("keeps the outage while the page says down, even when Stremlist's probe works", async () => {
      vi.stubEnv("TRAKT_CLIENT_ID", "trakt-app");
      pages.set("https://status.trakt.tv/", traktPage("danger"));
      await monitor();
      await monitor();
      expect(await outages()).toEqual(["trakt"]);

      pages.set("https://status.trakt.tv/", traktPage("success"));
      await monitor();
      expect(await outages()).toEqual([]);
    });

    it("ends an outage when the page says up and nothing probes the Provider", async () => {
      pages.set("https://status.trakt.tv/", traktPage("danger"));
      await monitor();
      pages.set("https://status.trakt.tv/", traktPage("success"));
      await monitor();
      expect(await outages()).toEqual([]);
    });

    it("ignores components that Stremlist does not read", async () => {
      pages.set("https://status.trakt.tv/", {
        psp: {
          monitors: [
            { name: "Trending", statusClass: "success", groupName: "API" },
            { name: "Web App", statusClass: "danger", groupName: "Web" },
          ],
        },
      });
      pages.set("https://status.mdblist.com/", {
        included: [
          {
            type: "status_page_resource",
            attributes: { public_name: "Lists Queue", status: "downtime" },
          },
          {
            type: "status_page_resource",
            attributes: { public_name: "api.mdblist.com", status: "degraded" },
          },
        ],
      });
      await monitor();
      expect(await outages()).toEqual([]);
    });

    it("reads the Simkl, MDBList and SensCritique pages", async () => {
      pages.set("https://status.simkl.com/", {
        psp: {
          monitors: [{ name: "API.simkl.com", statusClass: "danger" }],
        },
      });
      pages.set("https://status.mdblist.com/", {
        included: [
          {
            type: "status_page_resource",
            attributes: { public_name: "api.mdblist.com", status: "downtime" },
          },
        ],
      });
      pages.set("https://senscritique.instatus.com/", {
        components: [{ name: "senscritique.com", status: "MAJOROUTAGE" }],
      });
      const res = await monitor();
      const { statusPages } = await readJson(
        res,
        z.object({ statusPages: z.record(z.string(), z.string().nullable()) }),
      );
      expect(statusPages).toEqual({
        trakt: null,
        simkl: "down",
        mdblist: "down",
        senscritique: "down",
      });
      expect(await outages()).toEqual(["simkl", "mdblist", "senscritique"]);
    });

    it("treats a changed page format as no signal", async () => {
      pages.set("https://status.trakt.tv/", { monitors: "changed" });
      await monitor();
      await monitor();
      expect(await outages()).toEqual([]);
    });

    it("does not read the page of a turned-off Provider", async () => {
      vi.stubEnv("DISABLED_PROVIDERS", "trakt");
      pages.set("https://status.trakt.tv/", traktPage("danger"));
      await monitor();
      expect(
        db.getTable("provider_outages").map((row) => row.provider),
      ).not.toContain("trakt");
      expect(
        requests.filter((url) => url.startsWith("https://status.trakt.tv/")),
      ).toEqual([]);
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
    db.unavailableTables.add("provider_outages");
    const res = await app.request("/providers");
    expect(res.status).toBe(200);
    expect(await outages()).toEqual([]);
  });
});

describe("list checks", () => {
  const APPS_BEAT = "https://beat.example/apps";

  it("runs at most once per interval, whatever the number of calls", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    const first = await readJson(
      await monitor(),
      z.object({ listChecks: z.object({ started: z.boolean() }) }),
    );
    expect(first.listChecks.started).toBe(true);
    expect(listCheckRuns).toBe(1);
    expect(beats).toEqual([{ url: LBX_BEAT, method: "GET" }]);

    beats = [];
    const second = await monitor();
    expect(await second.json()).toMatchObject({
      listChecks: {
        started: false,
        last: { summary: { alarms: [], failures: {} } },
      },
    });
    await monitor();
    expect(listCheckRuns).toBe(1);
    expect(beats).toEqual([]);

    const row = db.getTable("monitor_runs")[0];
    row.started_at = new Date(Date.now() - 601_000).toISOString();
    await monitor();
    expect(listCheckRuns).toBe(2);
    expect(beats).toEqual([{ url: LBX_BEAT, method: "GET" }]);
  });

  it("starts no list checks when the run cannot be claimed", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    server.use(
      http.post(`${SUPABASE_REST}rpc/claim_monitor_run`, () =>
        HttpResponse.json({ message: "database down" }, { status: 500 }),
      ),
    );

    const res = await monitor();

    expect(res.status).toBe(200);
    expect(listCheckRuns).toBe(0);
    expect(beats).toEqual([]);
  });

  it("sends one ping to a heartbeat that several Providers share, and names each failure", async () => {
    vi.stubEnv("TRAKT_CLIENT_ID", "trakt-app");
    vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
    vi.stubEnv("MDBLIST_CLIENT_ID", "mdblist-app");
    for (const provider of ["TRAKT", "SIMKL", "MDBLIST"])
      vi.stubEnv(`BETTERSTACK_HEARTBEAT_URL_${provider}`, APPS_BEAT);
    simklTrending.set("trending/tv/week_100.json", 0);

    await monitor();

    expect(beats.filter((beat) => beat.url.startsWith(APPS_BEAT))).toEqual([
      { url: `${APPS_BEAT}/fail`, method: "POST" },
    ]);
    expect(failBodies.get(`${APPS_BEAT}/fail`)).toBe(
      "simkl:trending/tv (trending/tv): 0 entries, expected at least 50",
    );

    endListCheckInterval();
    beats = [];
    simklTrending.delete("trending/tv/week_100.json");
    await monitor();
    expect(beats.filter((beat) => beat.url.startsWith(APPS_BEAT))).toEqual([
      { url: APPS_BEAT, method: "GET" },
    ]);
  });

  it("reads the MDBList canaries at most once an hour, and keeps their results between reads", async () => {
    vi.stubEnv("MDBLIST_CLIENT_ID", "mdblist-app");
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_MDBLIST", APPS_BEAT);
    vi.stubEnv("MONITOR_ACCOUNT_ID", "sl_monitor");
    seedConnection("sl_monitor", "mdblist", { accessToken: "mdblist-token" });
    const isCanaryRead = (url: string) =>
      url.startsWith("https://api.mdblist.com/") &&
      !url.startsWith("https://api.mdblist.com/lists/top");
    let quotaUsed = true;
    server.use(
      http.get("https://api.mdblist.com/*", ({ request }) => {
        if (!quotaUsed || !isCanaryRead(request.url)) return undefined;
        tick();
        return HttpResponse.json({ error: "Rate limit" }, { status: 429 });
      }),
    );
    const canaryReads = () => requests.filter(isCanaryRead).length;
    const age = (name: string, seconds: number) => {
      const row = db.getTable("monitor_runs").find((run) => run.name === name);
      if (!row) throw new Error(`No run ${name}`);
      row.started_at = new Date(Date.now() - seconds * 1000).toISOString();
    };

    await monitor();
    const firstReads = canaryReads();
    expect(firstReads).toBeGreaterThan(0);
    expect(beats).toEqual([{ url: `${APPS_BEAT}/fail`, method: "POST" }]);
    const quotaFailures = failBodies.get(`${APPS_BEAT}/fail`);
    expect(quotaFailures).toContain(
      "mdblist:official/trending (official/trending): HTTP 429 from api.mdblist.com",
    );

    quotaUsed = false;
    for (let run = 0; run < 5; run++) {
      age("list-checks", 601);
      beats = [];
      failBodies = new Map();
      await monitor();
      expect(canaryReads()).toBe(firstReads);
      expect(beats).toEqual([{ url: `${APPS_BEAT}/fail`, method: "POST" }]);
      expect(failBodies.get(`${APPS_BEAT}/fail`)).toBe(quotaFailures);
    }

    age("list-checks", 601);
    age("list-checks:mdblist", 3500);
    await monitor();
    expect(canaryReads()).toBe(firstReads);

    age("list-checks", 601);
    age("list-checks:mdblist", 3601);
    beats = [];
    failBodies = new Map();
    await monitor();
    const secondReads = canaryReads();
    expect(secondReads).toBeGreaterThan(firstReads);
    expect(beats).toEqual([{ url: `${APPS_BEAT}/fail`, method: "POST" }]);
    const freshFailures = failBodies.get(`${APPS_BEAT}/fail`);
    expect(freshFailures).toContain(
      "mdblist:official/trending (official/trending): 0 entries, expected at least 160",
    );
    expect(freshFailures).not.toContain("HTTP 429");

    age("list-checks", 601);
    const saved = db
      .getTable("monitor_runs")
      .find((run) => run.name === "list-checks");
    if (saved) saved.summary = null;
    await monitor();
    expect(canaryReads()).toBeGreaterThan(secondReads);
  });

  it("fails the Provider's heartbeat for a failed canary, but shows no outage", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    letterboxd = (request) =>
      request.url === OFFICIAL_LIST
        ? new HttpResponse(letterboxdPage([1, 2, 3]))
        : unexpectedRequest(request);

    for (let run = 0; run < 3; run++) {
      endListCheckInterval();
      beats = [];
      const res = await monitor();
      expect(res.status).toBe(200);
      expect(beats).toEqual([{ url: `${LBX_BEAT}/fail`, method: "POST" }]);
    }
    expect(failBodies.get(`${LBX_BEAT}/fail`)).toContain(
      "letterboxd:users/{user}/lists/{slug}",
    );
    expect(await outages()).toEqual([]);
  });

  it("fails the Provider's heartbeat when real Lists of one type fail as unavailable", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", LBX_BEAT);
    const table = db.getTable("list_sync_status");
    for (const [index, reason] of [
      "unavailable",
      "unavailable",
      "unavailable",
      "private",
      null,
    ].entries())
      table.push({
        list_id: `list-${index}`,
        provider: "letterboxd",
        source_ref: `users/user${index}/films`,
        failure_reason: reason,
        last_attempt_at: new Date().toISOString(),
      });

    await monitor();

    expect(beats).toEqual([{ url: `${LBX_BEAT}/fail`, method: "POST" }]);
    expect(failBodies.get(`${LBX_BEAT}/fail`)).toBe(
      "letterboxd:users/{user}/films: 3 of 5 Lists fail as unavailable",
    );
    expect(await outages()).toEqual([]);
  });
});
