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
      justwatch:
        "https://www.justwatch.com/us/lists/tl-us-11111111-2222-4333-8444-555555555555",
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
      sourceRef: "tl-us-11111111-2222-4333-8444-555555555555",
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

    const split = { displayMode: "split" } as const;
    const created = await api.createAccount([
      listInput("trakt", "users/fixture-user/watchlist", split),
      listInput(
        "justwatch",
        "tl-us-11111111-2222-4333-8444-555555555555",
        split,
      ),
      listInput("senscritique", "users/fixture-user/wishes", split),
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
      expect(await api.listCatalogNames(accountId, row.id, "movie")).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await api.listCatalogNames(accountId, row.id, "series")).toEqual([
        "Breaking Bad",
      ]);
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
      listInput("simkl", "me/plantowatch", { displayMode: "split" }),
    ]);
    expect(saved.status).toBe(200);
    for (const row of (await api.getConfig(accountId)).body.lists) {
      expect(await api.listCatalogNames(accountId, row.id, "movie")).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await api.listCatalogNames(accountId, row.id, "series")).toEqual([
        "Breaking Bad",
      ]);
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
