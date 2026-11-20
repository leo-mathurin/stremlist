import { randomUUID } from "node:crypto";
import { expect } from "../integration-expect.js";
import { test } from "../integration-browser.js";
import { listInput } from "../helpers/api.js";
import {
  clearResolverCache,
  resetDb,
  seedAccount,
  seedConnection,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { present } from "../helpers/json.js";

let backend: FixtureBackend;

const SPLIT = { displayMode: "split" } as const;
const JUSTWATCH_REF = "tl-us-11111111-2222-4333-8444-555555555555";
const BOTH = { movie: ["The Shawshank Redemption"], series: ["Breaking Bad"] };

const catalogs = async (accountId: string, listId: string) => ({
  movie: await backend.api.listCatalogNames(accountId, listId, "movie"),
  series: await backend.api.listCatalogNames(accountId, listId, "series"),
});

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider.fixture.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
  await clearResolverCache("senscritique", ["101", "202"]);
  await clearResolverCache("letterboxd", ["film:101", "film:202"]);
});

test(
  "public links of Trakt, JustWatch and SensCritique become Catalogs",
  { tags: ["local"] },
  async () => {
    const { api } = backend;
    const links = {
      trakt: "https://trakt.tv/users/fixture-user/watchlist",
      justwatch: `https://www.justwatch.com/us/lists/${JUSTWATCH_REF}`,
      senscritique:
        "https://www.senscritique.com/fixture-user/collection?action=WISH",
    };
    expect(await api.resolveLink(links.trakt)).toEqual({
      ok: true,
      provider: "trakt",
      sourceRef: "users/fixture-user/watchlist",
      kind: "watchlist",
      requiresConnection: false,
      suggestedTitle: "fixture-user's watchlist",
      defaultDisplayMode: "split",
    });
    expect(await api.resolveLink(links.justwatch)).toMatchObject({
      ok: true,
      provider: "justwatch",
      sourceRef: JUSTWATCH_REF,
      kind: "list",
      suggestedTitle: "Weekend picks",
    });
    expect(await api.resolveLink(links.senscritique)).toMatchObject({
      ok: true,
      provider: "senscritique",
      sourceRef: "users/fixture-user/wishes",
      kind: "watchlist",
    });
    expect(
      await api.resolveLink("https://trakt.tv/users/private-user/watchlist"),
    ).toEqual({ ok: false, reason: "private", provider: "trakt" });
    expect(
      await api.resolveLink(
        "https://www.justwatch.com/us/lists/tl-us-99999999-2222-4333-8444-555555555555",
      ),
    ).toEqual({ ok: false, reason: "not_found", provider: "justwatch" });
    expect(
      await api.resolveLink("https://www.senscritique.com/private-user"),
    ).toEqual({ ok: false, reason: "private", provider: "senscritique" });

    const created = await api.createAccount([
      listInput("trakt", "users/fixture-user/watchlist", SPLIT),
      listInput("justwatch", JUSTWATCH_REF, SPLIT),
      listInput("senscritique", "users/fixture-user/wishes", SPLIT),
    ]);
    expect(created.status).toBe(200);
    const accountId = present(created.body.accountId, "the new Account ID");
    const { lists } = (await api.getConfig(accountId)).body;
    expect(lists.map((row) => row.provider)).toEqual([
      "trakt",
      "justwatch",
      "senscritique",
    ]);
    for (const row of lists) {
      expect(await catalogs(accountId, row.id)).toEqual(BOTH);
    }
    const traktReads = backend.requests((url) => url.host === "api.trakt.tv");
    expect(traktReads.length).toBeGreaterThan(0);
    expect(traktReads.every((entry) => entry.authorization === null)).toBe(
      true,
    );
    expect(
      backend.requests((url) => url.host === "query.wikidata.org").length,
    ).toBeGreaterThan(0);
  },
);

test(
  "MDBList and Simkl Source lists read through a Connection",
  { tags: ["local"] },
  async () => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "mdblist");
    await seedConnection(accountId, "simkl");
    const link = "https://mdblist.com/lists/fixture-user/weekend";
    expect(await api.resolveLink(link)).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
    expect(await api.resolveLink(link, accountId)).toMatchObject({
      ok: true,
      provider: "mdblist",
      sourceRef: "lists/4242",
      requiresConnection: true,
      suggestedTitle: "Weekend",
    });
    const sources = await api.getConnectionSources(accountId, "mdblist");
    expect(
      sources.body.sources.filter(
        (source: { ref: string }) => source.ref === "recommended/rising",
      ),
    ).toHaveLength(1);
    expect(sources.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "me/watchlist" }),
        expect.objectContaining({ ref: "me/ratings", label: "Ratings" }),
        expect.objectContaining({ ref: "me/history", label: "History" }),
        expect.objectContaining({
          ref: "official/trending",
          label: "Trending",
        }),
        expect.objectContaining({ ref: "me/up-next", label: "Up Next" }),
        expect.objectContaining({ ref: "me/collection", label: "Collection" }),
        expect.objectContaining({
          ref: "recommended/rising",
          label: "Rising Fast",
        }),
        expect.objectContaining({ ref: "me/lists/77", label: "Horror nights" }),
        expect.objectContaining({ ref: "lists/4242", label: "Weekend" }),
      ]),
    );
    expect(
      (await api.getConnectionSources(accountId, "simkl")).body.sources,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "me/plantowatch" }),
        expect.objectContaining({ ref: "me/ratings", label: "Ratings" }),
        expect.objectContaining({ ref: "me/airing-soon" }),
        expect.objectContaining({ ref: "me/continue-watching" }),
      ]),
    );

    const saved = await api.postConfig(accountId, [
      listInput("mdblist", "lists/4242", {
        catalogTitle: "Weekend",
        displayMode: "split",
      }),
      listInput("mdblist", "official/trending", SPLIT),
      listInput("simkl", "me/plantowatch", SPLIT),
      listInput("simkl", "me/ratings", SPLIT),
      listInput("simkl", "me/airing-soon", SPLIT),
      listInput("simkl", "me/continue-watching", SPLIT),
    ]);
    expect(saved.status).toBe(200);
    const expected = new Map([
      ["me/ratings", { movie: [], series: BOTH.series }],
      ["me/continue-watching", { movie: [], series: BOTH.series }],
      ["me/airing-soon", { movie: BOTH.movie, series: [] }],
    ]);
    for (const row of (await api.getConfig(accountId)).body.lists) {
      expect(await catalogs(accountId, row.id)).toEqual(
        expected.get(row.sourceRef) ?? BOTH,
      );
    }
    for (const host of ["api.mdblist.com", "api.simkl.com"]) {
      const reads = backend.requests((url) => url.host === host);
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.every((entry) => entry.authorization === "fixture-access-token"),
      ).toBe(true);
    }
  },
);

test(
  "Simkl trending, genre and DVD charts become Catalogs with no Connection",
  { tags: ["local"] },
  async () => {
    const { api } = backend;
    const created = await api.createAccount([
      listInput("simkl", "trending/movies", { displayMode: "movie" }),
      listInput("simkl", "trending/tv", { displayMode: "series" }),
      listInput("simkl", "trending/anime", { displayMode: "series" }),
      listInput("simkl", "trending/movies/today", { displayMode: "movie" }),
      listInput("simkl", "trending/tv/genre/drama", { displayMode: "series" }),
      listInput("simkl", "dvd/releases", { displayMode: "movie" }),
    ]);
    expect(created.status).toBe(200);
    const accountId = present(created.body.accountId, "the new Account ID");
    const shown: Record<string, unknown> = {};
    for (const row of (await api.getConfig(accountId)).body.lists) {
      shown[row.sourceRef] = await catalogs(accountId, row.id);
    }
    expect(shown).toEqual({
      "trending/movies": { movie: BOTH.movie, series: [] },
      "trending/tv": { movie: [], series: BOTH.series },
      "trending/anime": { movie: [], series: BOTH.series },
      "trending/movies/today": { movie: BOTH.movie, series: [] },
      "trending/tv/genre/drama": { movie: [], series: BOTH.series },
      "dvd/releases": { movie: BOTH.movie, series: [] },
    });
    const files = backend.requests((url) => url.host === "data.simkl.in");
    expect(new Set(files.map((entry) => new URL(entry.url).pathname))).toEqual(
      new Set([
        ...["movies", "tv", "anime"].map(
          (type) => `/discover/trending/${type}/week_100.json`,
        ),
        "/discover/trending/movies/today_100.json",
        "/discover/trending/tv/genre/drama_month_500.json",
        "/discover/dvd/releases_100.json",
      ]),
    );
    expect(files.every((entry) => entry.authorization === null)).toBe(true);
    expect(backend.requests((url) => url.host === "api.simkl.com")).toEqual([]);
  },
);

test(
  "Trakt charts and the Source lists of a Trakt Connection become Catalogs",
  { tags: ["local"] },
  async () => {
    const { api } = backend;

    const created = await api.createAccount([
      listInput("trakt", "trending", SPLIT),
      listInput("trakt", "popular", SPLIT),
      listInput("trakt", "calendars/shows/premieres", {
        displayMode: "series",
      }),
      listInput("trakt", "calendars/dvd", { displayMode: "movie" }),
    ]);
    expect(created.status).toBe(200);
    const publicId = present(created.body.accountId, "the new Account ID");
    const shownCharts: Record<string, unknown> = {};
    for (const row of (await api.getConfig(publicId)).body.lists) {
      shownCharts[row.sourceRef] = await catalogs(publicId, row.id);
    }
    expect(shownCharts).toEqual({
      trending: BOTH,
      popular: BOTH,
      "calendars/shows/premieres": { movie: [], series: BOTH.series },
      "calendars/dvd": { movie: BOTH.movie, series: [] },
    });
    const calendars = backend.requests((url) =>
      url.pathname.startsWith("/calendars/"),
    );
    expect(
      calendars.map((entry) =>
        new URL(entry.url).pathname.replace(/\d{4}-\d{2}-\d{2}/, "{today}"),
      ),
    ).toEqual(
      expect.arrayContaining([
        "/calendars/all/shows/premieres/{today}/30",
        "/calendars/all/dvd/{today}/30",
      ]),
    );
    expect(calendars.every((entry) => entry.authorization === null)).toBe(true);
    const charts = backend.requests((url) =>
      /^\/(movies|shows)\/(trending|popular)$/.test(url.pathname),
    );
    expect(new Set(charts.map((entry) => new URL(entry.url).pathname))).toEqual(
      new Set([
        "/movies/trending",
        "/shows/trending",
        "/movies/popular",
        "/shows/popular",
      ]),
    );
    expect(charts.every((entry) => entry.authorization === null)).toBe(true);

    backend.clearRequests();
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const saved = await api.postConfig(accountId, [
      listInput("trakt", "me/recommendations", SPLIT),
      listInput("trakt", "me/up-next", { displayMode: "series" }),
      listInput("trakt", "me/continue-watching", SPLIT),
      listInput("trakt", "me/calendar", SPLIT),
      listInput("trakt", "me/history", SPLIT),
      listInput("trakt", "me/collection", SPLIT),
    ]);
    expect(saved.status).toBe(200);
    const lists = (await api.getConfig(accountId)).body.lists;
    expect(lists.map((row) => row.sourceRef)).toEqual([
      "me/recommendations",
      "me/up-next",
      "me/continue-watching",
      "me/calendar",
      "me/history",
      "me/collection",
    ]);
    for (const row of lists) {
      expect(await catalogs(accountId, row.id)).toEqual(
        row.sourceRef === "me/up-next"
          ? { movie: [], series: BOTH.series }
          : BOTH,
      );
    }
    const progress = backend.requests((url) =>
      url.pathname.startsWith("/sync/progress/"),
    );
    expect(progress.map((entry) => new URL(entry.url).pathname)).toEqual(
      expect.arrayContaining([
        "/sync/progress/up_next",
        "/sync/progress/watched",
      ]),
    );
    expect(
      new URL(
        present(
          progress.find((entry) => entry.url.includes("/watched")),
          "the watched progress read",
        ).url,
      ).searchParams.get("hide_completed"),
    ).toBe("true");
    const personal = backend.requests(
      (url) =>
        url.host === "api.trakt.tv" &&
        /^\/(recommendations|sync\/progress|sync\/playback|calendars\/my|users\/me\/watched|sync\/collection)\//.test(
          url.pathname,
        ),
    );
    expect(personal.length).toBeGreaterThanOrEqual(12);
    expect(
      personal.every((entry) => entry.authorization === "fixture-access-token"),
    ).toBe(true);
  },
);

test(
  "public Letterboxd watchlists persist and share upstream reads between Accounts",
  { tags: ["local"] },
  async () => {
    const { api } = backend;
    const first = await seedAccount();
    const second = await seedAccount();
    backend.clearRequests();
    const username = `fixture_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const input = `https://letterboxd.com/${username}/watchlist/`;
    const sourceRef = `users/${username}/watchlist`;
    const resolved = await api.resolveLink(input, first);
    expect(resolved).toMatchObject({
      ok: true,
      provider: "letterboxd",
      sourceRef,
      requiresConnection: false,
    });
    for (const account of [first, second]) {
      const saved = await api.postConfig(account, [
        listInput("letterboxd", sourceRef, {
          ...SPLIT,
          catalogTitle: "Letterboxd Watchlist",
        }),
      ]);
      expect(saved.status).toBe(200);
      const config = await api.getConfig(account);
      expect(config.body.lists[0]).toMatchObject({
        provider: "letterboxd",
        sourceRef,
      });
      expect(await catalogs(account, config.body.lists[0].id)).toEqual(BOTH);
    }
    expect(
      backend.requests((url) => url.hostname === "letterboxd.com"),
    ).toHaveLength(1);
  },
);
