/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { PROVIDER_IDS } from "@stremlist/shared/providers";
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

import app from "../index.js";
import * as scraper from "../services/imdb-scraper";
import {
  legacyAccountId,
  OWNER,
  postJson,
  resetConfigTest,
} from "./helpers/config-api.js";
import { seedAccount, seedConnection } from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { FakeImdb, IMDB_GRAPHQL } from "./helpers/imdb.test-utils.js";
import {
  FakeLetterboxd,
  letterboxdPage,
} from "./helpers/letterboxd.test-utils.js";
import { db, rpcCallsOf } from "./helpers/mock-supabase.js";
import {
  haltLetterboxdGate,
  letterboxdGate,
} from "./helpers/supabase/letterboxd-gate-rpcs.js";
import { readJson } from "./helpers/json.js";
import { FakeMdblist } from "./helpers/mdblist.test-utils.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { FakeTrakt, useTraktApp } from "./helpers/trakt.test-utils.js";

const providersBody = z.object({
  providers: z.array(
    z
      .object({
        id: z.string(),
        enabled: z.boolean(),
        connectable: z.boolean(),
      })
      .loose(),
  ),
});

function haltLetterboxd() {
  haltLetterboxdGate();
}

const imdb = new FakeImdb();
const trakt = new FakeTrakt();
const letterboxd = new FakeLetterboxd();
const server = useMswServer();
useBackgroundTasks();
const mdblist = new FakeMdblist();

const queuedBody = z.object({
  ok: z.literal(false),
  reason: z.literal("queued"),
  provider: z.literal("letterboxd"),
  waitMs: z.number(),
  retryMs: z.number(),
  ticket: z.string(),
});

let now = Date.parse("2026-11-01T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 24 * 60 * 60_000;
  vi.setSystemTime(now);
  useTraktApp();
  resetConfigTest();
  imdb.reset();
  trakt.reset();
  letterboxd.reset();
  mdblist.reset();
  mdblist.reply("/lists/leo/top-movies", [
    { id: 4242, name: "Top movies", mediatype: "movie" },
  ]);
  server.use(
    imdb.handler,
    trakt.handler,
    ...letterboxd.handlers,
    mdblist.handler,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /links/resolve", () => {
  function resolve(input: string, accountKey?: string) {
    return postJson("/links/resolve", { input, accountKey });
  }

  it.each([
    ["not a link", { reason: "unrecognized" }],
    [
      "https://mdblist.com/lists/leo/top-movies",
      { reason: "needs_connection", provider: "mdblist" },
    ],
  ])("refuses %j with %j", async (input, expected) => {
    const res = await resolve(input);
    expect(await res.json()).toEqual({ ok: false, ...expected });
  });

  it("resolves a public Letterboxd watchlist without a Connection", async () => {
    letterboxd.serve(
      "https://letterboxd.com/leo/watchlist/",
      letterboxdPage([1]),
    );
    const res = await resolve("https://letterboxd.com/leo/watchlist/");
    expect(await res.json()).toMatchObject({
      ok: true,
      provider: "letterboxd",
      sourceRef: "users/leo/watchlist",
      requiresConnection: false,
    });
  });

  it("says when a Provider is turned off", async () => {
    vi.stubEnv("DISABLED_PROVIDERS", "imdb, trakt");

    const res = await resolve("https://trakt.tv/users/leo/watchlist");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "disabled",
      provider: "trakt",
    });
    expect(trakt.requests).toEqual([]);
  });

  it("lets a link check through to send Letterboxd's due recovery probe", async () => {
    letterboxd.serve(
      "https://letterboxd.com/leo/watchlist/",
      letterboxdPage([1]),
    );
    haltLetterboxd();
    const gate = letterboxdGate();
    if (gate) gate.nextProbeAt = Date.now() - 1;
    const res = await resolve("https://letterboxd.com/leo/watchlist/");
    expect(await res.json()).toMatchObject({ ok: true });
    expect(letterboxd.urls).toEqual(["https://letterboxd.com/leo/watchlist/"]);
  });

  it("answers with the Letterboxd queue state, then keeps the place with its ticket", async () => {
    vi.stubEnv("LETTERBOXD_MAX_RPS", "0.2");
    letterboxd.serveAll(letterboxdPage([1]));
    expect(
      await (await resolve("https://letterboxd.com/bob/watchlist/")).json(),
    ).toMatchObject({ ok: true });
    const turnsBefore = rpcCallsOf("letterboxd_take_turn").length;

    const queued = await readJson(
      await resolve("https://letterboxd.com/leo/watchlist/"),
      queuedBody,
    );
    expect(queued).toEqual({
      ok: false,
      reason: "queued",
      provider: "letterboxd",
      waitMs: 5_000,
      retryMs: 4_000,
      ticket: queued.ticket,
    });
    vi.setSystemTime(Date.now() + 5_000);
    const again = await postJson("/links/resolve", {
      input: "https://letterboxd.com/leo/watchlist/",
      ticket: queued.ticket,
    });
    expect(await again.json()).toMatchObject({ ok: true });
    expect(
      rpcCallsOf("letterboxd_take_turn")
        .slice(turnsBefore)
        .map((args) => args.p_ticket),
    ).toEqual([null, queued.ticket]);
    expect(letterboxd.urls).toEqual([
      "https://letterboxd.com/bob/watchlist/",
      "https://letterboxd.com/leo/watchlist/",
    ]);
  });

  it("says when Letterboxd is unavailable after it refused Stremlist", async () => {
    letterboxd.serveAll(letterboxdPage([1]));
    haltLetterboxd();
    try {
      const res = await resolve("https://letterboxd.com/leo/watchlist/");
      expect(await res.json()).toEqual({
        ok: false,
        reason: "disabled",
        provider: "letterboxd",
      });
      expect(letterboxd.requests).toEqual([]);
    } finally {
      db.reset();
    }
  });

  it("never uses a Connection for a Legacy alias", async () => {
    seedConnection(legacyAccountId, "mdblist");
    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      OWNER,
    );
    expect(
      (await readJson(res, z.object({ reason: z.string() }).loose())).reason,
    ).toBe("needs_connection");
  });

  it("asks for a Connection again when the Connection expired", async () => {
    const account = seedAccount();
    seedConnection(account.id, "mdblist", {
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: null,
    });

    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      account.id,
    );

    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
    expect(mdblist.requests).toEqual([]);
  });

  it("reports why a Provider refuses the Source list", async () => {
    trakt.paths.set("/users/leo", {
      status: 200,
      body: { username: "leo", ids: { slug: "leo" } },
    });
    trakt.fail("/users/leo/watchlist", 401);

    const res = await resolve("https://trakt.tv/users/leo/watchlist");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "private",
      provider: "trakt",
    });
  });

  it("validates through the Connection of a private Account", async () => {
    const account = seedAccount();
    seedConnection(account.id, "mdblist", {
      username: "leo",
      accessToken: "token-of-leo",
    });

    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      account.id,
    );

    expect(await res.json()).toEqual({
      ok: true,
      provider: "mdblist",
      sourceRef: "lists/4242",
      kind: "list",
      requiresConnection: true,
      suggestedTitle: "Top movies",
      defaultDisplayMode: "movie",
    });
    expect(
      mdblist.requests.map(({ path, token }) => ({ path, token })),
    ).toEqual([{ path: "/lists/leo/top-movies", token: "token-of-leo" }]);
  });

  it("resolves an IMDb watchlist link (p. handle) to its user ID", async () => {
    server.use(
      http.get("https://www.imdb.com/user/p.leo123/", () =>
        HttpResponse.html(`<script>{"userId":"${OWNER}"}</script>`),
      ),
    );
    imdb.watchlists.set(OWNER, []);
    const validate = vi.spyOn(scraper, "validateImdbWatchlist");

    const res = await resolve("https://www.imdb.com/user/p.leo123/watchlist");

    expect(await res.json()).toEqual({
      ok: true,
      provider: "imdb",
      sourceRef: OWNER,
      kind: "watchlist",
      requiresConnection: false,
      suggestedTitle: null,
      defaultDisplayMode: null,
    });
    expect(validate).toHaveBeenCalledWith("p.leo123");
  });

  it("reports a private IMDb watchlist", async () => {
    imdb.watchlists.set(OWNER, "private");

    const res = await resolve(OWNER);

    expect(await res.json()).toEqual({
      ok: false,
      reason: "private",
      provider: "imdb",
    });
  });

  it("resolves an IMDb chart without a network call", async () => {
    const res = await resolve("imdb:top-rated-movies");

    expect(await res.json()).toMatchObject({
      ok: true,
      provider: "imdb",
      sourceRef: "imdb:top-rated-movies",
      kind: "chart",
      suggestedTitle: "Top 250 Movies",
      defaultDisplayMode: "movie",
    });
  });

  it("answers unavailable when validation throws", async () => {
    server.use(http.post(IMDB_GRAPHQL, () => HttpResponse.error()));

    const res = await resolve(`https://www.imdb.com/user/${OWNER}/ratings`);

    expect(await res.json()).toEqual({
      ok: false,
      reason: "unavailable",
      provider: "imdb",
    });
  });
});

describe("GET /providers", () => {
  it("lists every Provider with its kill switch and OAuth status", async () => {
    vi.stubEnv("SIMKL_CLIENT_ID", "");
    vi.stubEnv("DISABLED_PROVIDERS", "justwatch");

    const res = await app.request("/providers");
    const { providers } = await readJson(res, providersBody);

    expect(providers.map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect(byId.get("trakt")).toEqual({
      id: "trakt",
      enabled: true,
      connectable: true,
      outageSince: null,
    });
    expect(byId.get("simkl")?.connectable).toBe(false);
    expect(byId.get("imdb")?.connectable).toBe(false);
    expect(byId.get("justwatch")?.enabled).toBe(false);
    expect(byId.get("letterboxd")?.enabled).toBe(true);
  });

  it("reports a halted Letterboxd as unavailable, like the kill switch", async () => {
    haltLetterboxd();
    try {
      const res = await app.request("/providers");
      const { providers } = await readJson(res, providersBody);
      const byId = new Map(
        providers.map((provider) => [provider.id, provider]),
      );
      expect(byId.get("letterboxd")?.enabled).toBe(false);
      expect(byId.get("imdb")?.enabled).toBe(true);
    } finally {
      db.reset();
    }
  });
});
