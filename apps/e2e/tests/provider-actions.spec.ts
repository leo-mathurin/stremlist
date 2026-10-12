import { expect, test } from "@playwright/test";
import { CONNECTION_SOURCES } from "@stremlist/shared/providers";
import { listInput } from "../helpers/api.js";
import {
  resetDb,
  seedAccount,
  seedConnection,
  seedList,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { LEGACY_ACTIONS_USER } from "../helpers/test-data.js";

// Actions from Stremio and the Provider kill switch against the real
// backend, database and R2 store. A separate backend with
// helpers/provider-fixtures.ts answers every Provider request with
// deterministic data (dummy client IDs, no real credentials) and logs what
// the backend sent, so the tests check each Provider write.

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
});

test(
  "Actions in Stremio open a Stremlist page that changes the Trakt watchlist",
  { tag: "@local" },
  async ({ page }) => {
    const { api } = backend;
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const saved = await api.postConfig(
      accountId,
      [
        listInput("trakt", "users/fixture-user/watchlist", {
          displayMode: "split",
        }),
      ],
      { actions: { enabled: true, providers: ["trakt"] } },
    );
    expect(saved.status).toBe(200);
    const manifest = await api.getManifest(accountId);
    expect(manifest.resources).toContainEqual({
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    });

    const streams = await api.getStreams(accountId, "movie", "tt0111161");
    const add = streams.body.streams.find((stream) =>
      stream.externalUrl?.includes("/actions/watchlist/add/"),
    );
    expect(add?.externalUrl).toBe(
      `${backend.url}/${accountId}/actions/watchlist/add/movie/tt0111161`,
    );

    await page.goto(add!.externalUrl!);
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is in your watchlist on Trakt",
      }),
    ).toBeVisible();
    const writes = backend.requests(
      (url) => url.pathname === "/sync/watchlist",
    );
    expect(writes).toMatchObject([
      {
        method: "POST",
        authorization: "fixture-access-token",
        body: { movies: [{ ids: { imdb: "tt0111161" } }] },
      },
    ]);

    // Actions never answer through a Legacy alias or without a Connection.
    const alias = LEGACY_ACTIONS_USER;
    await seedAccount({ legacyImdbUserId: alias });
    expect((await api.getStreams(alias, "movie", "tt0111161")).body).toEqual({
      streams: [],
      cacheMaxAge: 0,
    });
    await api.disconnect(accountId, "trakt");
    expect(
      (await api.getStreams(accountId, "movie", "tt0111161")).body.streams,
    ).toEqual([]);
  },
);

test(
  "every Trakt Action intent opens its page, writes Trakt and updates the entries",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount({ actions: ["trakt"] });
    await seedConnection(accountId, "trakt");
    const entries = async (type: string, id: string) =>
      (await backend.api.getStreams(accountId, type, id)).body.streams;
    const action = (path: string) =>
      `${backend.url}/${accountId}/actions/${path}`;
    const writes = (path: string) =>
      backend
        .requests((url) => url.pathname === path)
        .map((entry) => entry.body);
    const expectHeading = (name: string) =>
      expect(page.getByRole("heading", { name })).toBeVisible();

    // Watched, for one episode, then undone from the updated entry.
    await page.goto(action("watched/add/series/tt0903747%3A1%3A2"));
    await expectHeading("✓ Breaking Bad S01E02 is marked as watched on Trakt");
    const episode = {
      shows: [
        {
          ids: { imdb: "tt0903747" },
          seasons: [{ number: 1, episodes: [{ number: 2 }] }],
        },
      ],
    };
    expect(writes("/sync/history")).toEqual([episode]);
    const watched = (await entries("series", "tt0903747:1:2")).find((entry) =>
      entry.title?.startsWith("✅"),
    );
    expect(watched).toEqual({
      name: "Stremlist",
      title: "✅ S01E02 watched on Trakt\nSelect to mark as unwatched",
      externalUrl: action("watched/remove/series/tt0903747%3A1%3A2"),
    });
    await page.goto(watched!.externalUrl!);
    await expectHeading(
      "✓ Breaking Bad S01E02 is marked as unwatched on Trakt",
    );
    expect(writes("/sync/history/remove")).toEqual([episode]);

    // Watchlist: add, then remove from the entry that says it is there.
    const movie = { movies: [{ ids: { imdb: "tt0111161" } }] };
    await page.goto(action("watchlist/add/movie/tt0111161"));
    await expectHeading(
      "✓ The Shawshank Redemption is in your watchlist on Trakt",
    );
    const inWatchlist = (await entries("movie", "tt0111161"))[0];
    expect(inWatchlist).toEqual({
      name: "Stremlist",
      title: "🔖 In your Trakt watchlist\nSelect to remove",
      externalUrl: action("watchlist/remove/movie/tt0111161"),
    });
    await page.goto(inWatchlist.externalUrl!);
    await expectHeading(
      "✓ The Shawshank Redemption is out of your watchlist on Trakt",
    );
    expect(writes("/sync/watchlist/remove")).toEqual([movie]);

    // Rating: a form with 1 to 10, then the saved rating can be removed.
    const rate = (await entries("movie", "tt0111161")).at(-1);
    expect(rate).toEqual({
      name: "Stremlist",
      title: "⭐ Rate on Trakt",
      externalUrl: action("rating/rate/movie/tt0111161"),
    });
    await page.goto(rate!.externalUrl!);
    await expectHeading("Rate The Shawshank Redemption");
    await expect(page.getByRole("radio")).toHaveCount(10);
    await expect(page.getByRole("checkbox", { name: "Trakt" })).toBeChecked();
    await expect(page.getByText("Not rated")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove rating" }),
    ).toHaveCount(0);
    await page.getByText("8", { exact: true }).click();
    await page.getByRole("button", { name: "Save rating" }).click();
    await expectHeading("✓ The Shawshank Redemption is rated 8/10 on Trakt");
    expect(writes("/sync/ratings")).toEqual([
      { movies: [{ ids: { imdb: "tt0111161" }, rating: 8 }] },
    ]);
    expect((await entries("movie", "tt0111161")).at(-1)?.title).toBe(
      "⭐ Rated 8/10, change\nTrakt",
    );
    await page.goto(rate!.externalUrl!);
    await expect(page.getByText("Now 8/10")).toBeVisible();
    await expect(page.getByRole("radio", { name: "8" })).toBeChecked();
    await page.getByRole("button", { name: "Remove rating" }).click();
    await expectHeading(
      "✓ The Shawshank Redemption has no rating on Trakt now",
    );
    expect(writes("/sync/ratings/remove")).toEqual([movie]);

    // A link with an unknown intent, or for another Account, changes nothing.
    const syncWrites = () =>
      backend.requests((url) => url.pathname.startsWith("/sync/")).length;
    const before = syncWrites();
    for (const path of [
      `/${accountId}/actions/watchlist/toggle/movie/tt0111161`,
      `/${accountId}/actions/watched/add/movie/not-a-title`,
      "/sl_0000000000000000000000/actions/watchlist/add/movie/tt0111161",
    ]) {
      const response = await page.goto(`${backend.url}${path}`);
      expect(response?.status()).toBe(404);
      await expectHeading("This link does not work");
    }
    expect(syncWrites()).toBe(before);
  },
);

test(
  "Simkl and MDBList Actions write each Provider, and a rating goes to the chosen ones",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount({ actions: ["simkl", "mdblist"] });
    await seedConnection(accountId, "simkl");
    await seedConnection(accountId, "mdblist");
    const titles = async (type: string, id: string) =>
      (await backend.api.getStreams(accountId, type, id)).body.streams.map(
        (entry) => entry.title,
      );
    const action = (path: string) =>
      `${backend.url}/${accountId}/actions/${path}`;
    const writes = (host: string, path: string) =>
      backend
        .requests((url) => url.host === host && url.pathname === path)
        .filter((entry) => entry.method === "POST")
        .map((entry) => entry.body);
    const expectHeading = (name: string) =>
      expect(page.getByRole("heading", { name })).toBeVisible();
    const movie = { ids: { imdb: "tt0111161" } };

    // The first entries read the library of each Provider in the background:
    // both have the movie in their watchlist, neither watched or rated it.
    await expect
      .poll(() => titles("movie", "tt0111161"))
      .toEqual([
        "🔖 In watchlist on Simkl and MDBList\nSelect to remove from all",
        "✅ Mark as watched\nSimkl and MDBList",
        "⭐ Rate\nFrom 1 to 10 on Simkl and MDBList",
      ]);
    expect(
      backend.requests((url) => url.pathname === "/sync/all-items/movies"),
    ).toHaveLength(1);

    // Watched: one page writes both Providers.
    await page.goto(action("watched/add/movie/tt0111161"));
    await expectHeading(
      "✓ The Shawshank Redemption is marked as watched on Simkl and MDBList",
    );
    expect(writes("api.simkl.com", "/sync/history")).toEqual([
      { movies: [movie] },
    ]);
    expect(writes("api.mdblist.com", "/sync/watched")).toEqual([
      { movies: [movie] },
    ]);
    expect((await titles("movie", "tt0111161"))[1]).toBe(
      "✅ Watched on Simkl and MDBList\nSelect to mark as unwatched everywhere",
    );

    // Rating: the form names both Providers; only the checked one gets it.
    await page.goto(action("rating/rate/movie/tt0111161"));
    await expectHeading("Rate The Shawshank Redemption");
    const simkl = page.getByRole("checkbox", { name: "Simkl" });
    const mdblist = page.getByRole("checkbox", { name: "MDBList" });
    await expect(simkl).toBeChecked();
    await expect(mdblist).toBeChecked();
    await expect(page.getByText("Not rated")).toHaveCount(2);
    await mdblist.uncheck();
    await page.getByText("7", { exact: true }).click();
    await page.getByRole("button", { name: "Save rating" }).click();
    await expectHeading("✓ The Shawshank Redemption is rated 7/10 on Simkl");
    expect(writes("api.simkl.com", "/sync/ratings")).toEqual([
      { movies: [{ ...movie, rating: 7 }] },
    ]);
    expect(writes("api.mdblist.com", "/sync/ratings")).toEqual([]);
    expect((await titles("movie", "tt0111161")).at(-1)).toBe(
      "⭐ 7/10 on Simkl, change\nNot rated on MDBList",
    );

    // A Provider that refuses the Title fails alone, and the page says so.
    await page.goto(action("watchlist/add/movie/tt0068646"));
    await expectHeading("✓ This title is in your watchlist on Simkl");
    await expect(
      page.getByText(
        "It did not work on MDBList. Try again later, or connect the account again on the Stremlist configure page.",
      ),
    ).toBeVisible();
    const godfather = { movies: [{ ids: { imdb: "tt0068646" } }] };
    expect(writes("api.simkl.com", "/sync/add-to-list")).toEqual([
      { movies: [{ ...godfather.movies[0], to: "plantowatch" }] },
    ]);
    expect(writes("api.mdblist.com", "/watchlist/items/add")).toEqual([
      godfather,
    ]);
    expect((await titles("movie", "tt0068646")).slice(0, 2)).toEqual([
      "🔖 Add to watchlist\nMDBList (already on Simkl)",
      "🔖 Remove from watchlist\nSimkl",
    ]);
  },
);

test(
  "the kill switch stops every Provider request but keeps cached Catalogs",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount({ actions: ["trakt"] });
    await seedConnection(accountId, "trakt");
    const justwatchRef = "tl-us-11111111-2222-4333-8444-555555555555";
    const cached = await seedList(accountId, {
      provider: "justwatch",
      sourceRef: justwatchRef,
      catalogTitle: "",
      position: 0,
    });
    const uncached = await seedList(accountId, {
      provider: "senscritique",
      sourceRef: "users/fixture-user/wishes",
      catalogTitle: "",
      position: 1,
    });
    // The running backend reads the JustWatch list once, into R2.
    expect(
      await backend.api.listCatalogNames(accountId, cached, "movie"),
    ).toEqual(["The Shawshank Redemption"]);

    const off = await startFixtureBackend("./provider-fixtures.ts", {
      DISABLED_PROVIDERS: "justwatch,senscritique,trakt",
    });
    try {
      backend.clearRequests();
      off.clearRequests();
      const status = await off.api.getProviders();
      expect(
        status.body.providers
          .filter((provider) => !provider.enabled)
          .map((provider) => provider.id)
          .sort(),
      ).toEqual(["justwatch", "senscritique", "trakt"]);
      expect(
        await off.api.resolveLink(
          `https://www.justwatch.com/us/lists/${justwatchRef}`,
        ),
      ).toEqual({ ok: false, reason: "disabled", provider: "justwatch" });

      // The cached Catalog stays; a List without a cache explains why.
      const catalog = async (listId: string) =>
        (await off.api.getCatalog(accountId, "movie", `wl-${listId}-movie`))
          .metas;
      expect((await catalog(cached)).map((meta) => meta.name)).toEqual([
        "The Shawshank Redemption",
      ]);
      expect(await catalog(uncached)).toMatchObject([
        {
          id: "stremlist:unavailable:disabled",
          name: "⚠️ SensCritique is temporarily unavailable",
          description: "Please try again later.",
        },
      ]);

      // No Connection, own list or Action goes through a Provider that is off.
      expect(await off.api.startConnection(accountId, "trakt")).toEqual({
        status: 503,
        body: { error: "Trakt is temporarily unavailable." },
      });
      expect(
        (await off.api.getConnectionSources(accountId, "trakt")).body,
      ).toEqual({ sources: CONNECTION_SOURCES.trakt });
      expect(
        (await off.api.getStreams(accountId, "movie", "tt0111161")).body,
      ).toEqual({ streams: [], cacheMaxAge: 0 });
      // The Catalog preview reads nothing either.
      expect(
        (
          await off.api.previewList({
            accountKey: accountId,
            provider: "senscritique",
            sourceRef: "users/fixture-user/wishes",
            sortOption: "added_at-asc",
          })
        ).body,
      ).toEqual({ ok: false, reason: "disabled" });
      expect([...off.requests(), ...backend.requests()]).toEqual([]);
    } finally {
      await off.stop();
    }
  },
);

test(
  "concurrent Actions from separate backends preserve both membership changes",
  { tag: "@local" },
  async ({ request }) => {
    const writer = await startFixtureBackend("./provider-fixtures.ts");
    const reader = await startFixtureBackend("./provider-fixtures.ts");
    try {
      const accountId = await seedAccount({ actions: ["trakt"] });
      await seedConnection(accountId, "trakt");
      const responses = await Promise.all([
        request.get(
          `${backend.url}/${accountId}/actions/watchlist/add/movie/tt0111161`,
        ),
        request.get(
          `${writer.url}/${accountId}/actions/watched/add/movie/tt0111161`,
        ),
      ]);
      for (const response of responses) {
        expect(response.status()).toBe(200);
        expect(await response.text()).toContain('class="ok"');
      }
      // A third process has no local copy: both changes must be stored in R2.
      const streams = (
        await reader.api.getStreams(accountId, "movie", "tt0111161")
      ).body.streams;
      expect(streams.map((stream) => stream.title)).toEqual(
        expect.arrayContaining([
          "🔖 In your Trakt watchlist\nSelect to remove",
          "✅ Watched on Trakt\nSelect to mark as unwatched",
        ]),
      );
    } finally {
      await Promise.all([writer.stop(), reader.stop()]);
    }
  },
);
