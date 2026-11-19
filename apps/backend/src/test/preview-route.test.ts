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
import {
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import { readJson } from "./helpers/json.js";
import { cache } from "./helpers/list-cache.test-utils.js";
import { db, resetRpc, rpcCallsOf } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { resetR2 } from "./helpers/r2.test-utils.js";
import { FakeTrakt, useTraktApp } from "./helpers/trakt.test-utils.js";

const server = useMswServer();
useBackgroundTasks();
const imdb = new FakeImdb();
const trakt = new FakeTrakt();

const TITLE = movie("tt0111161", { name: "The Shawshank Redemption" });
const GODFATHER = movie("tt0068646", { name: "The Godfather" });

function preview(body: Record<string, unknown>) {
  return app.request("/lists/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sortOption: "added_at-asc", ...body }),
  });
}

function letterboxdPage(ids: number[]) {
  return `<html><head><title>A list • Letterboxd</title></head><body><h1>A list</h1><ul class="poster-list -grid">${ids.map((id) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="film-${id}" data-item-name="Film ${id} (2000)"></li>`).join("")}</ul></body></html>`;
}

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
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  trakt.reset();
  server.use(imdb.handler, trakt.handler, cinemetaWithoutTitles);
  imdb.titles.set(TITLE.id, TITLE);
  imdb.titles.set(GODFATHER.id, GODFATHER);
  trakt.serve("/users/me/watchlist", [TITLE]);
  trakt.serve("/users/someone/watchlist", [TITLE]);
  trakt.serve("/users/a/watchlist", [TITLE]);
  trakt.serve("/users/me/watched/movies", [TITLE]);
  trakt.serve("/users/me/watched/shows", []);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /lists/preview", () => {
  it("previews every Source list of a merged List, through the Account's Connection", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt", { accessToken: "token-of-account" });
    imdb.watchlists.set("ur1000001", [TITLE, GODFATHER]);

    const res = await preview({
      accountKey: account.id,
      provider: "imdb",
      sourceRef: "ur1000001",
      mergedSources: [{ provider: "trakt", sourceRef: "me/watchlist" }],
      sortOption: "title-asc",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, titleCount: 2 });
    expect(
      trakt.requestsOf("/users/me/watchlist").map((request) => request.token),
    ).toEqual(["token-of-account"]);
  });

  it("answers with the queue state while a Source list waits for Letterboxd, then previews with the same ticket", async () => {
    vi.stubEnv("LETTERBOXD_MAX_RPS", "0.025");
    server.use(
      http.get("https://letterboxd.com/:user/watchlist/", () =>
        HttpResponse.text(letterboxdPage([1])),
      ),
      http.post("https://query.wikidata.org/sparql", () =>
        HttpResponse.json({
          results: {
            bindings: [
              { external: { value: "film-1" }, imdb: { value: TITLE.id } },
            ],
          },
        }),
      ),
    );
    const first = await preview({
      provider: "letterboxd",
      sourceRef: "users/bob/watchlist",
    });
    expect(first.status).toBe(200);
    const turnsBefore = rpcCallsOf("letterboxd_take_turn").length;
    const list = {
      provider: "letterboxd",
      sourceRef: "users/alice/watchlist",
      mergedSources: [{ provider: "trakt", sourceRef: "users/a/watchlist" }],
    };

    const queued = await readJson(await preview(list), queuedBody);
    expect(queued).toEqual({
      ok: false,
      reason: "queued",
      provider: "letterboxd",
      waitMs: 40_000,
      retryMs: 15_000,
      ticket: queued.ticket,
    });
    vi.setSystemTime(Date.now() + 40_000);
    const ready = await preview({ ...list, ticket: queued.ticket });
    expect(await ready.json()).toMatchObject({ ok: true, titleCount: 1 });
    expect(
      rpcCallsOf("letterboxd_take_turn")
        .slice(turnsBefore)
        .filter((args) => args.p_priority === "first")
        .map((args) => args.p_ticket),
    ).toEqual([null, queued.ticket]);
    expect(trakt.requestsOf("/users/a/watchlist")).toHaveLength(1);
  });

  it("refuses more than five Source lists, like a save", async () => {
    const res = await preview({
      provider: "imdb",
      sourceRef: "ur1000001",
      mergedSources: Array.from({ length: 5 }, (_, index) => ({
        provider: "imdb",
        sourceRef: `ls10000000${index}`,
      })),
    });

    expect(res.status).toBe(400);
  });

  it("previews a public Source list without an Account", async () => {
    const res = await preview({
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      titleCount: 1,
      catalogs: [
        {
          type: "movie",
          preset: null,
          total: 1,
          titles: [{ id: TITLE.id, name: TITLE.name }],
        },
        { type: "series", preset: null, total: 0, titles: [] },
      ],
      unresolved: { count: 0, notCheckedYet: 0, entries: [] },
    });
    expect(trakt.requests.map(({ path, token }) => ({ path, token }))).toEqual([
      { path: "/users/someone/watchlist", token: null },
    ]);
  });

  it("reads through the Connection of a private Account", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt", { accessToken: "token-of-account" });

    const res = await preview({
      accountKey: account.id,
      provider: "trakt",
      sourceRef: "me/history",
    });

    expect(await res.json()).toMatchObject({ ok: true, titleCount: 1 });
    expect(trakt.requests.map(({ path, token }) => ({ path, token }))).toEqual(
      expect.arrayContaining([
        { path: "/users/me/watched/movies", token: "token-of-account" },
        { path: "/users/me/watched/shows", token: "token-of-account" },
      ]),
    );
    expect(trakt.requests).toHaveLength(2);
  });

  it("never reads through a Connection for a Legacy alias", async () => {
    const account = seedLegacyAccount("ur12345678");
    seedConnection(account.id, "trakt");

    const res = await preview({
      accountKey: "ur12345678",
      provider: "trakt",
      sourceRef: "me/history",
    });

    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
    });
    expect(trakt.requests).toEqual([]);
  });

  it("treats an unknown Account key like a new setup", async () => {
    const res = await preview({
      accountKey: "sl_0000000000000000000000",
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
    });

    expect(await res.json()).toMatchObject({ ok: true });
    expect(trakt.requests.map(({ path, token }) => ({ path, token }))).toEqual([
      { path: "/users/someone/watchlist", token: null },
    ]);
  });

  it("refuses a malformed request", async () => {
    const unknownProvider = await preview({
      provider: "netflix",
      sourceRef: "x",
    });
    const badSort = await preview({
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
      sortOption: "loudness-desc",
    });
    const badKey = await preview({
      accountKey: "not-a-key",
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
    });

    expect(unknownProvider.status).toBe(400);
    expect(badSort.status).toBe(400);
    expect(badKey.status).toBe(400);
  });
});
