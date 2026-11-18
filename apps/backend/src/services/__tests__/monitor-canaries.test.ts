import type { ProviderId } from "@stremlist/shared/providers";
import {
  isProviderId,
  listTypeOf,
  listTypes,
  PROVIDER_IDS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import { db } from "../../__tests__/helpers/mock-supabase";
import type { ConnectionAccess } from "../../providers/types";
import { SourceBusyError } from "../../providers/types";
import type { CanaryResult, CanarySpec } from "../monitor/canaries";
import {
  CANARIES,
  canaryRefsFromEnv,
  plannedCanaries,
  runCanaries,
} from "../monitor/canaries";

vi.mock(
  "../../lib/supabase",
  () => import("../../__tests__/helpers/mock-supabase"),
);
vi.mock(
  "../../providers/registry",
  () => import("../../__tests__/helpers/mock-registry"),
);
const { getConnectionAccess } = vi.hoisted(() => ({
  getConnectionAccess:
    vi.fn<
      (
        accountId: string,
        provider: ProviderId,
      ) => Promise<ConnectionAccess | null>
    >(),
}));
vi.mock("../connections", () => ({ getConnectionAccess }));

const MONITOR_ACCOUNT = "sl_monitor";

function entries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    imdbId: `tt${String(index).padStart(7, "0")}`,
  }));
}

function connectionOf(provider: ProviderId) {
  return {
    accountId: MONITOR_ACCOUNT,
    provider,
    username: "monitor",
    authorization: "v1",
    getAccessToken: () => Promise.resolve("token"),
    reportRefused: () => Promise.resolve(),
    reportWorking: () => Promise.resolve(),
  };
}

let reads: { provider: ProviderId; ref: string; connection: boolean }[];
function fakeEveryProvider(count: (ref: string) => number = () => 1000) {
  for (const provider of PROVIDER_IDS)
    useFakeProvider(
      fakeAdapter(provider, {
        fetchSource: (ref, ctx) => {
          reads.push({ provider, ref, connection: ctx.connection !== null });
          return Promise.resolve({
            entries: entries(count(ref)),
            complete: true,
          });
        },
        oauth: { authorizeUrl: "", tokenUrl: "", clientId: () => "app" },
      }),
    );
}

function resultOf(results: CanaryResult[], type: string) {
  const result = results.find((candidate) => candidate.type === type);
  if (!result) throw new Error(`No result for ${type}`);
  return result;
}

beforeEach(() => {
  db.reset();
  resetProviders();
  reads = [];
  vi.stubEnv("MONITOR_ACCOUNT_ID", "");
  vi.stubEnv("MONITOR_CANARY_REFS", "");
  getConnectionAccess.mockReset();
  getConnectionAccess.mockImplementation((_account, provider) =>
    Promise.resolve(connectionOf(provider)),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    fakeEveryProvider();
    const fetchSource = vi.fn(() =>
      Promise.resolve({ entries: entries(300), complete: true }),
    );
    useFakeProvider(fakeAdapter("imdb", { fetchSource }));

    const results = await runCanaries();

    expect(resultOf(results, "imdb:chart/top-rated-movies")).toEqual({
      type: "imdb:chart/top-rated-movies",
      provider: "imdb",
      ref: "imdb:top-rated-movies",
      status: "ok",
      entries: 300,
      min: 200,
    });
    expect(fetchSource).toHaveBeenCalledWith("imdb:top-rated-movies", {
      connection: null,
      forceRefresh: true,
    });
    expect(results.map((result) => result.type).sort()).toEqual(
      listTypes().sort(),
    );
  });

  it("fails a canary that gives fewer entries than its minimum, and names the list type", async () => {
    fakeEveryProvider((ref) => (ref === "ls055592025" ? 12 : 1000));

    const results = await runCanaries();

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
    fakeEveryProvider();
    useFakeProvider(
      fakeAdapter("senscritique", {
        fetchSource: () => Promise.reject(new Error("GraphQL changed")),
      }),
    );
    useFakeProvider(
      fakeAdapter("letterboxd", {
        fetchSource: () => Promise.reject(new SourceBusyError(60_000)),
      }),
    );

    const results = await runCanaries();

    expect(resultOf(results, "senscritique:lists/{id}")).toMatchObject({
      status: "failed",
      error: "GraphQL changed",
    });
    expect(
      resultOf(results, "letterboxd:users/{user}/lists/{slug}").status,
    ).toBe("skipped");
  });

  it("lists Connection types as not covered without MONITOR_ACCOUNT_ID, and never reads them", async () => {
    fakeEveryProvider();

    const results = await runCanaries();

    expect(resultOf(results, "trakt:me/history")).toEqual({
      type: "trakt:me/history",
      provider: "trakt",
      status: "not_covered",
      reason: "MONITOR_ACCOUNT_ID is not set",
    });
    expect(reads.filter((read) => read.connection)).toEqual([]);
    expect(getConnectionAccess).not.toHaveBeenCalled();
  });

  it("reads Connection types through the monitor Account's Connection", async () => {
    vi.stubEnv("MONITOR_ACCOUNT_ID", MONITOR_ACCOUNT);
    getConnectionAccess.mockImplementation((_account, provider) =>
      Promise.resolve(provider === "simkl" ? null : connectionOf(provider)),
    );
    fakeEveryProvider((ref) => (ref === "me/history" ? 0 : 1000));

    const results = await runCanaries();

    expect(resultOf(results, "trakt:me/watchlist").status).toBe("ok");
    expect(resultOf(results, "trakt:me/history")).toMatchObject({
      status: "failed",
      error: "0 entries, expected at least 1",
    });
    expect(resultOf(results, "simkl:me/plantowatch")).toMatchObject({
      status: "not_covered",
      reason: "The monitor Account has no simkl Connection",
    });
    for (const read of reads)
      expect(read.connection).toBe(
        sourceRequiresConnection(read.provider, read.ref),
      );
    expect(
      getConnectionAccess.mock.calls.filter(
        ([, provider]) => provider === "trakt",
      ),
    ).toHaveLength(1);
  });

  it("does not read a Provider that is turned off or whose app is not set", async () => {
    vi.stubEnv("DISABLED_PROVIDERS", "justwatch");
    fakeEveryProvider();
    useFakeProvider(
      fakeAdapter("trakt", {
        oauth: { authorizeUrl: "", tokenUrl: "", clientId: () => undefined },
      }),
    );

    const results = await runCanaries();

    expect(resultOf(results, "justwatch:{list}")).toMatchObject({
      status: "not_covered",
      reason: "justwatch is unavailable (turned off or halted)",
    });
    expect(resultOf(results, "trakt:trending")).toMatchObject({
      status: "not_covered",
      reason: "The trakt app is not set",
    });
    expect(reads.map((read) => read.provider)).not.toContain("justwatch");
    expect(reads.map((read) => read.provider)).not.toContain("trakt");
  });
});
