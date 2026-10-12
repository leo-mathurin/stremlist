import { expect, test } from "@playwright/test";
import { listInput } from "../helpers/api.js";
import {
  clearResolverCache,
  resetDb,
  seedAccount,
  seedConnection,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";

// Provider links against the real backend, database and R2 store: the real
// adapters resolve links and read Source lists, and a separate backend with
// helpers/provider-fixtures.ts answers every Provider request with
// deterministic data (dummy client IDs, no real credentials). Letterboxd is
// out of scope.

let backend: FixtureBackend;

const SPLIT = { displayMode: "split" } as const;
const JUSTWATCH_REF = "tl-us-11111111-2222-4333-8444-555555555555";
/** What every fixture Source list shows. */
const BOTH = { movie: ["The Shawshank Redemption"], series: ["Breaking Bad"] };

/** The names in the movie and series Catalogs of a List. */
const catalogs = async (accountId: string, listId: string) => ({
  movie: await backend.api.listCatalogNames(accountId, listId, "movie"),
  series: await backend.api.listCatalogNames(accountId, listId, "series"),
});

test.beforeAll(async () => {
  backend = await startFixtureBackend("./provider-fixtures.ts");
});
test.afterAll(async () => {
  await backend?.stop();
});

test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
  // The ID resolver caches SensCritique products across runs.
  await clearResolverCache("senscritique", ["101", "202"]);
});

test(
  "public links of Trakt, JustWatch and SensCritique become Catalogs",
  { tag: "@local" },
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
    // Expected refusals of the same Providers.
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
    const accountId = created.body.accountId!;
    const { lists } = (await api.getConfig(accountId)).body;
    expect(lists.map((row) => row.provider)).toEqual([
      "trakt",
      "justwatch",
      "senscritique",
    ]);
    for (const row of lists) {
      expect(await catalogs(accountId, row.id)).toEqual(BOTH);
    }
    // Public reads carry the app's client ID and no user token.
    const traktReads = backend.requests((url) => url.host === "api.trakt.tv");
    expect(traktReads.length).toBeGreaterThan(0);
    expect(traktReads.every((entry) => entry.authorization === null)).toBe(
      true,
    );
    // SensCritique products resolved to IMDb IDs through Wikidata.
    expect(
      backend.requests((url) => url.host === "query.wikidata.org").length,
    ).toBeGreaterThan(0);
  },
);

test(
  "MDBList and Simkl Source lists read through a Connection",
  { tag: "@local" },
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
    expect(sources.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "me/watchlist" }),
        expect.objectContaining({ ref: "me/lists/77", label: "Horror nights" }),
      ]),
    );

    const saved = await api.postConfig(accountId, [
      listInput("mdblist", "lists/4242", {
        catalogTitle: "Weekend",
        displayMode: "split",
      }),
      listInput("simkl", "me/plantowatch", SPLIT),
    ]);
    expect(saved.status).toBe(200);
    for (const row of (await api.getConfig(accountId)).body.lists) {
      expect(await catalogs(accountId, row.id)).toEqual(BOTH);
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
  "Trakt charts and the Source lists of a Trakt Connection become Catalogs",
  { tag: "@local" },
  async () => {
    const { api } = backend;

    // Charts need no Connection: the app's client ID reads them.
    const created = await api.createAccount([
      listInput("trakt", "trending", SPLIT),
      listInput("trakt", "popular", SPLIT),
    ]);
    expect(created.status).toBe(200);
    const publicId = created.body.accountId!;
    for (const row of (await api.getConfig(publicId)).body.lists) {
      expect(await catalogs(publicId, row.id)).toEqual(BOTH);
    }
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

    // Recommendations, Up Next, History and Collection read through the
    // Connection, with the user's token.
    backend.clearRequests();
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const saved = await api.postConfig(accountId, [
      listInput("trakt", "me/recommendations", SPLIT),
      listInput("trakt", "me/up-next", { displayMode: "series" }),
      listInput("trakt", "me/history", SPLIT),
      listInput("trakt", "me/collection", SPLIT),
    ]);
    expect(saved.status).toBe(200);
    const lists = (await api.getConfig(accountId)).body.lists;
    expect(lists.map((row) => row.sourceRef)).toEqual([
      "me/recommendations",
      "me/up-next",
      "me/history",
      "me/collection",
    ]);
    for (const row of lists) {
      expect(await catalogs(accountId, row.id)).toEqual(
        // Up Next lists the series in progress, not movies.
        row.sourceRef === "me/up-next"
          ? { movie: [], series: BOTH.series }
          : BOTH,
      );
    }
    // Trakt refuses Up Next to some apps: the watched progress gives the same rows.
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
        progress.find((entry) => entry.url.includes("/watched"))!.url,
      ).searchParams.get("hide_completed"),
    ).toBe("true");
    const personal = backend.requests(
      (url) =>
        url.host === "api.trakt.tv" &&
        /^\/(recommendations|sync\/progress|users\/me\/watched|sync\/collection)\//.test(
          url.pathname,
        ),
    );
    expect(personal.length).toBeGreaterThanOrEqual(8);
    expect(
      personal.every((entry) => entry.authorization === "fixture-access-token"),
    ).toBe(true);
  },
);
