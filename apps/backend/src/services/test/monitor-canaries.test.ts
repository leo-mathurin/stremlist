import {
  isProviderId,
  listTypeOf,
  listTypes,
  PROVIDER_IDS,
} from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";
import { movie, seedConnection } from "../../test/helpers/account.fixture";
import { onFakeClock } from "../../test/helpers/clock.test-utils";
import {
  cinemetaWithoutTitles,
  FakeImdb,
  imdbTitle,
} from "../../test/helpers/imdb.test-utils";
import { FakeLetterboxd } from "../../test/helpers/letterboxd.test-utils";
import { FakeMdblist } from "../../test/helpers/mdblist.test-utils";
import { db, resetRpc, rpcHandlers } from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { resetR2 } from "../../test/helpers/r2.test-utils";
import {
  FakeSensCritique,
  SENSCRITIQUE_GRAPHQL,
} from "../../test/helpers/senscritique.test-utils";
import { FakeSimkl, useSimklApp } from "../../test/helpers/simkl.test-utils";
import { FakeTrakt, useTraktApp } from "../../test/helpers/trakt.test-utils";
import {
  clearTrendingReads,
  readTrending,
} from "../../providers/simkl/trending";
import * as Connections from "../connections";
import type { CanaryResult, CanarySpec } from "../monitor/canaries";
import {
  CANARIES,
  canaryRefsFromEnv,
  plannedCanaries,
  runCanaries,
} from "../monitor/canaries";

const JUSTWATCH = "https://apis.justwatch.com/*";

const operation = z.object({ operationName: z.string() });

class ImdbWithCharts extends FakeImdb {
  chart: StremioMeta[] = [];

  override async answer(request: Request) {
    const { operationName } = operation.parse(await request.clone().json());
    if (operationName !== "ChartTitles") return super.answer(request);
    this.requests.push({ operationName, variables: {} });
    return HttpResponse.json({
      data: {
        chartTitles: {
          edges: this.chart.map((meta) => ({ node: imdbTitle(meta) })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
}

const imdb = new ImdbWithCharts();
const trakt = new FakeTrakt();
const simkl = new FakeSimkl();
const mdblist = new FakeMdblist();
const senscritique = new FakeSensCritique();
const letterboxd = new FakeLetterboxd();
const server = useMswServer();
const getConnectionAccess = vi.spyOn(Connections, "getConnectionAccess");

const MONITOR_ACCOUNT = "sl_monitor";
const justwatchRequests: string[] = [];

function titles(count: number) {
  return Array.from({ length: count }, (_, index) =>
    movie(`tt${String(index + 1).padStart(7, "0")}`),
  );
}

function resultOf(results: CanaryResult[], type: string) {
  const result = results.find((candidate) => candidate.type === type);
  if (!result) throw new Error(`No result for ${type}`);
  return result;
}

function personalTraktPath(path: string) {
  return /^\/(users\/me|sync|recommendations)\//.test(path);
}

let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  db.reset();
  resetRpc();
  resetR2();
  clearTrendingReads();
  vi.clearAllMocks();
  vi.stubEnv("MONITOR_ACCOUNT_ID", "");
  vi.stubEnv("MONITOR_CANARY_REFS", "");
  vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
  vi.stubEnv("TMDB_API_KEY", "");
  for (const app of ["TRAKT", "SIMKL", "MDBLIST"]) {
    vi.stubEnv(`${app}_CLIENT_ID`, "");
  }
  for (const fake of [imdb, trakt, simkl, mdblist, senscritique, letterboxd]) {
    fake.reset();
  }
  imdb.fail("BoxOffice");
  imdb.fail("ComingSoon");
  imdb.fail("UserRatings");
  trakt.failOthers(404);
  for (const kind of ["movies", "tv", "anime"]) {
    for (const period of ["week", "today", "month"]) {
      simkl.failTrending(`${kind}/${period}_100.json`, 404);
    }
  }
  simkl.failTrending("dvd/releases_100.json", 404);
  simkl.failTrending("movies/genre/horror_month_500.json", 404);
  imdb.chart = titles(1000);
  imdb.watchlists.set("ur195879360", titles(1000));
  imdb.lists.set("ls055592025", titles(1000));
  justwatchRequests.length = 0;
  rpcHandlers.set("letterboxd_take_turn", () => ({
    data: { status: "paused", wait_ms: 60_000, probe: false, ticket: null },
    error: null,
  }));
  server.use(
    imdb.handler,
    cinemetaWithoutTitles,
    trakt.handler,
    ...simkl.handlers,
    mdblist.handler,
    senscritique.handler,
    ...letterboxd.handlers,
    http.post(JUSTWATCH, ({ request }) => {
      justwatchRequests.push(request.url);
      return new HttpResponse(null, { status: 503 });
    }),
  );
  for (const provider of PROVIDER_IDS) {
    seedConnection(MONITOR_ACCOUNT, provider, {
      username: "monitor",
      accessToken: `${provider}-token`,
    });
  }
});
afterEach(() => {
  clock = Date.now();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("canary coverage", () => {
  it("has a canary, or a written reason for none, for every list type that Stremlist offers", () => {
    expect(Object.keys(CANARIES).sort()).toEqual(listTypes().sort());
    for (const spec of Object.values<CanarySpec>(CANARIES)) {
      if ("none" in spec) expect(spec.none.length).toBeGreaterThan(20);
      else expect(spec.min).toBeGreaterThan(0);
    }
  });

  it("gives each default Source list the list type that it checks", () => {
    for (const [type, spec] of Object.entries<CanarySpec>(CANARIES)) {
      if ("none" in spec || !spec.ref) continue;
      const provider = type.slice(0, type.indexOf(":"));
      if (!isProviderId(provider)) throw new Error(`Bad list type ${type}`);
      expect(listTypeOf(provider, spec.ref)).toBe(type);
    }
  });
});

describe("MONITOR_CANARY_REFS", () => {
  it("reads provider:ref entries, with an optional minimum, by list type", () => {
    const refs = canaryRefsFromEnv(
      "trakt:users/alice/watchlist=40, letterboxd:users/bob/diary\nnope:x bad",
    );
    expect(Object.fromEntries(refs)).toEqual({
      "trakt:users/{user}/watchlist": {
        ref: "users/alice/watchlist",
        min: 40,
      },
      "letterboxd:users/{user}/diary": { ref: "users/bob/diary" },
    });
  });

  it("replaces a default Source list and its minimum", () => {
    const planned = plannedCanaries(
      canaryRefsFromEnv("imdb:ur99999999=5"),
    ).find((canary) => canary.type === "imdb:ur/watchlist");
    expect(planned).toMatchObject({ ref: "ur99999999", min: 5 });
  });
});

describe("runCanaries", () => {
  it("reads each covered list type once through the adapter, with forceRefresh", async () => {
    useSimklApp();
    imdb.chart = titles(300);
    simkl.trending.set("movies/week_100.json", titles(100));
    await readTrending("trending/movies");

    const results = await onFakeClock(() => runCanaries());

    expect(resultOf(results, "imdb:chart/top-rated-movies")).toEqual({
      type: "imdb:chart/top-rated-movies",
      provider: "imdb",
      ref: "imdb:top-rated-movies",
      status: "ok",
      entries: 300,
      min: 200,
    });
    expect(resultOf(results, "simkl:trending/movies")).toMatchObject({
      status: "ok",
      entries: 100,
    });
    expect(simkl.requestsOf("movies/week_100.json")).toHaveLength(2);
    expect(simkl.requests.every((request) => request.token === null)).toBe(
      true,
    );
    expect(results.map((result) => result.type).sort()).toEqual(
      listTypes().sort(),
    );
  });

  it("fails a canary that gives fewer entries than its minimum, and names the list type", async () => {
    imdb.lists.set("ls055592025", titles(12));

    const results = await onFakeClock(() => runCanaries());

    expect(resultOf(results, "imdb:ls/list")).toEqual({
      type: "imdb:ls/list",
      provider: "imdb",
      ref: "ls055592025",
      status: "failed",
      entries: 12,
      min: 80,
      error: "12 entries, expected at least 80",
    });
    expect(resultOf(results, "imdb:ur/watchlist").status).toBe("ok");
  });

  it("fails a canary whose read throws, and skips one that waits for a busy queue", async () => {
    senscritique.error = "GraphQL changed";

    const results = await onFakeClock(() => runCanaries());

    const failed = resultOf(results, "senscritique:lists/{id}");
    expect(failed).toMatchObject({
      status: "failed",
      error: "SensCritique GraphQL error: GraphQL changed",
    });
    expect("transient" in failed).toBe(false);
    expect(
      resultOf(results, "letterboxd:users/{user}/lists/{slug}").status,
    ).toBe("skipped");
    expect(letterboxd.requests).toEqual([]);
  });

  it("marks a canary that fails for a server error as transient", async () => {
    server.use(
      http.post(
        SENSCRITIQUE_GRAPHQL,
        () => new HttpResponse(null, { status: 502 }),
      ),
    );

    const results = await onFakeClock(() => runCanaries());

    expect(resultOf(results, "senscritique:lists/{id}")).toMatchObject({
      status: "failed",
      transient: true,
    });
  });

  it("lists Connection types as not covered without MONITOR_ACCOUNT_ID, and never reads them", async () => {
    useTraktApp();

    const results = await onFakeClock(() => runCanaries());

    expect(resultOf(results, "trakt:me/history")).toEqual({
      type: "trakt:me/history",
      provider: "trakt",
      status: "not_covered",
      reason: "MONITOR_ACCOUNT_ID is not set",
    });
    expect(trakt.requests).not.toEqual([]);
    expect(trakt.requests.filter((request) => request.token)).toEqual([]);
    expect(
      trakt.requests.filter((request) => personalTraktPath(request.path)),
    ).toEqual([]);
    expect(getConnectionAccess).not.toHaveBeenCalled();
  });

  it("reads Connection types through the monitor Account's Connection", async () => {
    useTraktApp();
    useSimklApp();
    vi.stubEnv("MONITOR_ACCOUNT_ID", MONITOR_ACCOUNT);
    db.delete("connections", (row) => row.provider === "simkl");
    trakt.serve("/users/me/watchlist", titles(3));
    trakt.serve("/users/me/watched/movies", []);
    trakt.serve("/users/me/watched/shows", []);

    const results = await onFakeClock(() => runCanaries());

    expect(resultOf(results, "trakt:me/watchlist").status).toBe("ok");
    expect(resultOf(results, "trakt:me/history")).toMatchObject({
      status: "failed",
      error: "0 entries, expected at least 1",
    });
    expect(resultOf(results, "simkl:me/plantowatch")).toMatchObject({
      status: "not_covered",
      reason: "The monitor Account has no simkl Connection",
    });
    expect(trakt.requests.some((request) => request.token === null)).toBe(true);
    for (const request of trakt.requests)
      expect([request.path, request.token]).toEqual([
        request.path,
        personalTraktPath(request.path) ? "trakt-token" : null,
      ]);
    expect(
      getConnectionAccess.mock.calls.filter(
        ([, provider]) => provider === "trakt",
      ),
    ).toHaveLength(1);
  });

  it("does not read a Provider that is turned off or whose app is not set", async () => {
    vi.stubEnv("DISABLED_PROVIDERS", "justwatch");

    const results = await onFakeClock(() => runCanaries());

    expect(resultOf(results, "justwatch:{list}")).toMatchObject({
      status: "not_covered",
      reason: "justwatch is unavailable (turned off or halted)",
    });
    expect(resultOf(results, "trakt:trending")).toMatchObject({
      status: "not_covered",
      reason: "The trakt app is not set",
    });
    expect(justwatchRequests).toEqual([]);
    expect(trakt.requests).toEqual([]);
  });
});
