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

    // Watched, for one episode, then undone from the updated entry.
    await page.goto(action("watched/add/series/tt0903747%3A1%3A2"));
    await expect(
      page.getByRole("heading", {
        name: "✓ Breaking Bad S01E02 is marked as watched on Trakt",
      }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("heading", {
        name: "✓ Breaking Bad S01E02 is marked as unwatched on Trakt",
      }),
    ).toBeVisible();
    expect(writes("/sync/history/remove")).toEqual([episode]);

    // Watchlist: add, then remove from the entry that says it is there.
    const movie = { movies: [{ ids: { imdb: "tt0111161" } }] };
    await page.goto(action("watchlist/add/movie/tt0111161"));
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is in your watchlist on Trakt",
      }),
    ).toBeVisible();
    const inWatchlist = (await entries("movie", "tt0111161"))[0];
    expect(inWatchlist).toEqual({
      name: "Stremlist",
      title: "🔖 In your Trakt watchlist\nSelect to remove",
      externalUrl: action("watchlist/remove/movie/tt0111161"),
    });
    await page.goto(inWatchlist.externalUrl!);
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is out of your watchlist on Trakt",
      }),
    ).toBeVisible();
    expect(writes("/sync/watchlist/remove")).toEqual([movie]);

    // Rating: a form with 1 to 10, then the saved rating can be removed.
    const rate = (await entries("movie", "tt0111161")).at(-1);
    expect(rate).toEqual({
      name: "Stremlist",
      title: "⭐ Rate on Trakt",
      externalUrl: action("rating/rate/movie/tt0111161"),
    });
    await page.goto(rate!.externalUrl!);
    await expect(
      page.getByRole("heading", { name: "Rate The Shawshank Redemption" }),
    ).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(10);
    await expect(page.getByRole("checkbox", { name: "Trakt" })).toBeChecked();
    await expect(page.getByText("Not rated")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove rating" }),
    ).toHaveCount(0);
    await page.getByText("8", { exact: true }).click();
    await page.getByRole("button", { name: "Save rating" }).click();
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption is rated 8/10 on Trakt",
      }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("heading", {
        name: "✓ The Shawshank Redemption has no rating on Trakt now",
      }),
    ).toBeVisible();
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
      await expect(
        page.getByRole("heading", { name: "This link does not work" }),
      ).toBeVisible();
    }
    expect(syncWrites()).toBe(before);
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
