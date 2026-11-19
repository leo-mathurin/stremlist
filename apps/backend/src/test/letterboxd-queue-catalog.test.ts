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
import app from "../index.js";
import { getListCatalog } from "../services/lists";
import { movie, seedAccount, seedList } from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { postJson } from "./helpers/config-api.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import {
  FakeLetterboxd,
  letterboxdPage,
} from "./helpers/letterboxd.test-utils.js";
import { cache } from "./helpers/list-cache.test-utils.js";
import { db, resetRpc, rpcCallsOf } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { resetR2 } from "./helpers/r2.test-utils.js";
import { letterboxdWaiters } from "./helpers/supabase/letterboxd-gate-rpcs.js";
import { FakeWikidata } from "./helpers/wikidata.test-utils.js";
import { metasBody, readJson, syncSnapshotBody } from "./helpers/json.js";

const LIST_ID = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const REF = "users/alice/watchlist";
const WATCHLIST = "https://letterboxd.com/alice/watchlist/";
const PAGE_2 = `${WATCHLIST}page/2/`;
const FRESHNESS_MS = 6 * 60 * 60_000;
const SUPABASE_REST = new URL("/rest/v1/", process.env.SUPABASE_URL).href;
const TAKE_TURN = `${SUPABASE_REST}rpc/letterboxd_take_turn`;

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();
const letterboxd = new FakeLetterboxd();
const wikidata = new FakeWikidata();

let accountId = "";

function film(id: number) {
  const imdbId = `tt${String(id).padStart(7, "0")}`;
  imdb.titles.set(imdbId, movie(imdbId));
  wikidata.link("P6127", `film-${id}`, imdbId);
}

function serveWatchlist(...pages: number[][]) {
  pages.forEach((ids, index) => {
    ids.forEach(film);
    const next =
      index + 1 < pages.length
        ? `/alice/watchlist/page/${index + 2}/`
        : undefined;
    letterboxd.serve(
      index === 0 ? WATCHLIST : `${WATCHLIST}page/${index + 1}/`,
      letterboxdPage(ids, next),
    );
  });
}

function holdPage(url: string, ids: number[]) {
  ids.forEach(film);
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  letterboxd.serve(url, async () => {
    arrived.resolve();
    await release.promise;
    return new HttpResponse(letterboxdPage(ids));
  });
  return { arrived: arrived.promise, release: () => release.resolve() };
}

const turnBody = z.object({ p_ticket: z.string().nullable() }).loose();

async function busyLetterboxd() {
  vi.stubEnv("LETTERBOXD_MAX_RPS", "0.1");
  letterboxd.serve("https://letterboxd.com/bob/watchlist/", letterboxdPage([]));
  expect(
    await (
      await postJson("/links/resolve", {
        input: "https://letterboxd.com/bob/watchlist/",
      })
    ).json(),
  ).toMatchObject({ ok: true });
  const turn = Promise.withResolvers<void>();
  server.use(
    http.post(TAKE_TURN, async ({ request }) => {
      if (turnBody.parse(await request.clone().json()).p_ticket !== null) {
        await turn.promise;
      }
    }),
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    vi.setSystemTime(Date.now() + 10_000);
    turn.resolve();
  };
  return {
    turnsBefore: rpcCallsOf("letterboxd_take_turn").length,
    release,
    async nextTurn() {
      release();
      await background.settle();
    },
  };
}

function firstPageTickets(after: number) {
  return rpcCallsOf("letterboxd_take_turn")
    .slice(after)
    .filter((args) => args.p_priority !== "background")
    .map((args) => args.p_ticket);
}

async function catalog(suffix = ".json") {
  const res = await app.request(
    `/${accountId}/catalog/movie/wl-${LIST_ID}-movie${suffix}`,
  );
  return { res, body: await readJson(res, metasBody) };
}

const ids = (body: { metas: StremioMeta[] }) =>
  body.metas.map((meta) => meta.id);

function seedStaleCatalog() {
  cache.seed(
    LIST_ID,
    [movie("tt0000009")],
    new Date(Date.now() - FRESHNESS_MS - 60_000),
    { provider: "letterboxd", sourceRef: REF },
  );
}

let now = Date.parse("2026-11-01T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 24 * 60 * 60_000;
  vi.setSystemTime(now);
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  letterboxd.reset();
  wikidata.reset();
  server.use(
    imdb.handler,
    ...letterboxd.handlers,
    wikidata.handler,
    cinemetaWithoutTitles,
  );
  accountId = seedAccount().id;
  seedList(accountId, { id: LIST_ID, provider: "letterboxd", source_ref: REF });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a Stremio request for a busy Letterboxd", () => {
  it("shows the on-its-way card instead of a 500, and goes on in the background with the same place in the queue", async () => {
    serveWatchlist([1]);
    const queue = await busyLetterboxd();

    let ticket: string | undefined;
    try {
      const { res, body } = await catalog();

      expect(res.status).toBe(200);
      expect(body.metas).toEqual([
        expect.objectContaining({
          id: "stremlist:queued:letterboxd",
          name: "Your Letterboxd list is on its way",
          description:
            "Letterboxd is busy right now. Stremlist is reading your list and it will show here in a few minutes.",
        }),
      ]);
      [ticket] = letterboxdWaiters().map((waiter) => waiter.id);
    } finally {
      queue.release();
    }
    await queue.nextTurn();
    expect(cache.get(LIST_ID)?.data.metas.map((meta) => meta.id)).toEqual([
      "tt0000001",
    ]);
    expect(firstPageTickets(queue.turnsBefore)).toEqual([null, ticket]);
    expect(
      db
        .getTable("list_sync_status")
        .filter((row) => row.failure_reason !== null),
    ).toEqual([]);
    expect(ids((await catalog()).body)).toEqual(["tt0000001"]);
  });

  it("shows no card in a search", async () => {
    serveWatchlist([1]);
    const queue = await busyLetterboxd();

    try {
      const { res, body } = await catalog("/search=alien.json");

      expect(res.status).toBe(200);
      expect(body.metas).toEqual([]);
    } finally {
      queue.release();
    }
    await queue.nextTurn();
  });

  it("waits at most 10 s, then shows the card while the read goes on", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    vi.setSystemTime(now);
    const page = holdPage(WATCHLIST, [2]);
    const written = Promise.withResolvers<void>();
    cache.beforeWrite = (listId) => {
      if (listId === LIST_ID) written.resolve();
      return Promise.resolve();
    };

    const pending = catalog();
    try {
      await page.arrived;
      await vi.advanceTimersByTimeAsync(9_900);
      let answered = false;
      void pending.then(() => (answered = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const { body } = await pending;
      expect(ids(body)).toEqual(["stremlist:queued:letterboxd"]);
    } finally {
      page.release();
    }

    await written.promise;
    await background.settle();
    expect(cache.get(LIST_ID)?.data.metas.map((meta) => meta.id)).toEqual([
      "tt0000002",
    ]);
  });

  it("serves the pages read so far, comes back soon and completes them in the background", async () => {
    serveWatchlist([1], [2]);
    const queue = await busyLetterboxd();
    vi.setSystemTime(Date.now() + 10_000);

    try {
      const { body } = await catalog();

      expect(ids(body)).toEqual(["tt0000001"]);
      const cached = cache.get(LIST_ID);
      expect(cached).not.toBeNull();
      const age = Date.now() - (cached?.cachedAt.getTime() ?? 0);
      expect(age).toBeGreaterThan(FRESHNESS_MS - 2 * 60_000 - 1_000);
      expect(age).toBeLessThan(FRESHNESS_MS);
    } finally {
      queue.release();
    }
    await queue.nextTurn();
    expect(cache.get(LIST_ID)?.data.metas).toHaveLength(2);
    expect(letterboxd.urls.filter((url) => url.startsWith(WATCHLIST))).toEqual([
      WATCHLIST,
      PAGE_2,
    ]);
  });

  it("serves a stale Catalog at once and reads in the background", async () => {
    seedStaleCatalog();
    const page = holdPage(WATCHLIST, [10]);
    const turnsBefore = rpcCallsOf("letterboxd_take_turn").length;

    try {
      const { res, body } = await catalog();

      expect(res.status).toBe(200);
      expect(ids(body)).toEqual(["tt0000009"]);
      await page.arrived;
      expect(
        rpcCallsOf("letterboxd_take_turn")
          .slice(turnsBefore)
          .map((args) => args.p_priority),
      ).toEqual(["background"]);
    } finally {
      page.release();
    }
    await background.settle();
    expect(cache.get(LIST_ID)?.data.metas.map((meta) => meta.id)).toEqual([
      "tt0000010",
    ]);
  });

  it("keeps the stale Catalog when a later page of the background read has to wait", async () => {
    seedStaleCatalog();
    vi.stubEnv("LETTERBOXD_MAX_RPS", "0.1");
    serveWatchlist([10], [11]);

    expect(ids((await catalog()).body)).toEqual(["tt0000009"]);
    await background.settle();

    expect(letterboxd.urls).toEqual([WATCHLIST]);
    expect(cache.get(LIST_ID)?.data.metas.map((meta) => meta.id)).toEqual([
      "tt0000009",
    ]);
  });
});

describe("a stale Catalog of a revoked Letterboxd list", () => {
  it("is dropped when the background read finds the list gone", async () => {
    letterboxd.fail(WATCHLIST, 404);
    seedStaleCatalog();

    expect(ids((await catalog()).body)).toEqual(["tt0000009"]);
    await background.settle();
    expect(cache.get(LIST_ID)).toBeNull();
    expect(ids((await catalog()).body)).toEqual([
      "stremlist:unavailable:not_found",
    ]);
  });
});

describe("a save that waits for a busy Letterboxd", () => {
  it("shows the estimate on the configure page while the read waits", async () => {
    serveWatchlist([1]);
    vi.stubEnv("LETTERBOXD_MAX_RPS", "1");
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    vi.setSystemTime(now);
    db.letterboxdWaiters = Array.from({ length: 85 }, (_, seq) => ({
      id: `other-read-${seq}`,
      gate: "production",
      seq: -100 + seq,
      lane: 0,
      waiting: true,
      dueAt: now + 500,
      expiresAt: now + 60_000,
    }));
    const estimated = Promise.withResolvers<void>();
    const estimate = ({ request }: { request: Request }) => {
      if (
        request.method === "POST" &&
        request.url.startsWith(`${SUPABASE_REST}list_read_queue`)
      ) {
        estimated.resolve();
      }
    };
    server.events.on("response:mocked", estimate);
    const prewarm = getListCatalog(
      { id: LIST_ID, provider: "letterboxd", sourceRef: REF },
      {
        accountId,
        sort: { by: "added_at", order: "asc" },
        allowConnection: true,
        policy: "prewarm",
      },
    );

    const status = async () =>
      (
        await readJson(
          await app.request(`/${accountId}/sync-status`),
          syncSnapshotBody,
        )
      ).readQueue ?? {};
    await estimated.promise;
    server.events.removeListener("response:mocked", estimate);
    expect(Object.keys(await status())).toEqual([LIST_ID]);
    const queued = (await status())[LIST_ID];
    expect(queued.provider).toBe("letterboxd");
    const readyAt = Date.parse(queued.readyAt);
    expect(readyAt - Date.now()).toBeGreaterThan(80_000);
    expect(readyAt - Date.now()).toBeLessThanOrEqual(90_000);

    db.letterboxdWaiters = [];
    await vi.advanceTimersByTimeAsync(15_000);
    await prewarm;
    expect(await status()).toEqual({});
  });
});
