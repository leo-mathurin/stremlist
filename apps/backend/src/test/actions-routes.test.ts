import type { ProviderId } from "@stremlist/shared/providers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import app from "../index.js";
import {
  movie,
  seedAccount,
  seedConnection,
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import { cache } from "./helpers/list-cache.test-utils.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";
import { readJson, streamsBody } from "./helpers/json.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { r2Objects, resetR2 } from "./helpers/r2.test-utils.js";
import { FakeSimkl } from "./helpers/simkl.test-utils.js";
import { FakeTrakt, useTraktApp } from "./helpers/trakt.test-utils.js";

const MOVIE = "tt0111161";
const SERIES = "tt0903747";

const server = useMswServer();
useBackgroundTasks();
const imdb = new FakeImdb();
const trakt = new FakeTrakt();
const simkl = new FakeSimkl();

const SYNCED = { status: 201, body: { not_found: { movies: [], shows: [] } } };

function traktWrites() {
  return trakt.requests
    .filter((request) => request.method === "POST")
    .map(({ path, body, token }) => ({ path, body, token }));
}

function simklWrites() {
  return simkl.requests
    .filter((request) => request.method === "POST")
    .map(({ method, url }) => ({ method, path: url.pathname }));
}

interface Membership {
  watchlist: string[];
  watched: string[];
  watchedEpisodes: string[];
  ratings: Record<string, number>;
}

function seedMembership(
  accountId: string,
  provider: ProviderId,
  membership: Partial<Membership>,
) {
  r2Objects.set(
    `connections/${accountId}/${provider}/membership.json`,
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      username: "leo",
      membership: {
        watchlist: [],
        watched: [],
        watchedEpisodes: [],
        ratings: {},
        ...membership,
      },
    }),
  );
}

function seedActionAccount(
  overrides: {
    enabled?: boolean;
    providers?: ProviderId[];
    legacy?: true;
  } = {},
) {
  const providers = overrides.providers ?? ["trakt"];
  const account = seedAccount({
    actions_enabled: overrides.enabled ?? true,
    action_providers: providers,
    legacy_imdb_user_id: overrides.legacy && "ur12345678",
  });
  for (const provider of providers) seedConnection(account.id, provider);
  return account;
}

function postForm(path: string, form: [string, string][]) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

let now = Date.parse("2026-11-01T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 24 * 60 * 60_000;
  vi.setSystemTime(now);
  useTraktApp();
  vi.stubEnv("SIMKL_CLIENT_ID", "simkl-app");
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  imdb.reset();
  trakt.reset();
  simkl.reset();
  imdb.titles.set(MOVIE, movie(MOVIE, { name: "The Title" }));
  imdb.titles.set(SERIES, movie(SERIES, { type: "series", name: "The Title" }));
  for (const path of [
    "/sync/watchlist",
    "/sync/watchlist/remove",
    "/sync/history",
    "/sync/history/remove",
    "/sync/ratings",
    "/sync/ratings/remove",
  ]) {
    trakt.paths.set(path, SYNCED);
  }
  server.use(
    imdb.handler,
    trakt.handler,
    cinemetaWithoutTitles,
    ...simkl.handlers,
  );
  vi.spyOn(console, "error");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /:accountKey/stream/:type/:id.json", () => {
  beforeEach(() => {
    for (const path of [
      "/users/me/watchlist",
      "/sync/watched/movies",
      "/sync/watched/shows",
      "/sync/ratings/movies",
      "/sync/ratings/shows",
    ]) {
      trakt.serve(path, []);
    }
  });

  it("returns Action entries that open Stremlist pages, never cached", async () => {
    const account = seedActionAccount();

    const res = await app.request(`/${account.id}/stream/movie/${MOVIE}.json`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await readJson(res, streamsBody);
    expect(body.cacheMaxAge).toBe(0);
    expect(body.streams.map((stream) => stream.externalUrl)).toEqual([
      `http://localhost/${account.id}/actions/watchlist/add/movie/${MOVIE}`,
      `http://localhost/${account.id}/actions/watched/add/movie/${MOVIE}`,
      `http://localhost/${account.id}/actions/rating/rate/movie/${MOVIE}`,
    ]);
    for (const stream of body.streams) {
      expect(stream).not.toHaveProperty("url");
      expect(stream).not.toHaveProperty("behaviorHints");
    }
  });

  it("keeps the episode in the Action link and uses the public origin", async () => {
    vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.stremlist.test/");
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/stream/series/${SERIES}:2:5.json`,
    );

    const body = await readJson(res, streamsBody);
    expect(body.streams[1]).toMatchObject({
      title: "✅ Mark S02E05 as watched on Trakt",
      externalUrl: `https://api.stremlist.test/${account.id}/actions/watched/add/series/${SERIES}%3A2%3A5`,
    });
  });

  it("returns nothing through a Legacy alias, even with Actions on", async () => {
    seedActionAccount({ legacy: true });

    const res = await app.request(`/ur12345678/stream/movie/${MOVIE}.json`);

    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });

  it("returns nothing when Actions are off", async () => {
    const account = seedActionAccount({ enabled: false });

    const res = await app.request(`/${account.id}/stream/movie/${MOVIE}.json`);

    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });

  it.each([`movie/kitsu:1.json`, `channel/${MOVIE}.json`])(
    "returns nothing for %s",
    async (path) => {
      const account = seedActionAccount();

      const res = await app.request(`/${account.id}/stream/${path}`);

      expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
    },
  );

  it("returns nothing for an unknown Addon URL", async () => {
    const res = await app.request(
      `/sl_0000000000000000000000/stream/movie/${MOVIE}.json`,
    );

    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });
});

describe("Action pages", () => {
  it("adds to the watchlist and shows the result", async () => {
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watchlist/add/movie/${MOVIE}`,
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The Title is in your watchlist on Trakt");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(traktWrites()).toEqual([
      {
        path: "/sync/watchlist",
        body: { movies: [{ ids: { imdb: MOVIE } }] },
        token: "access-token",
      },
    ]);
  });

  it("removes from the watchlist", async () => {
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watchlist/remove/movie/${MOVIE}`,
    );

    expect(await res.text()).toContain(
      "The Title is out of your watchlist on Trakt",
    );
    expect(traktWrites()).toEqual([
      {
        path: "/sync/watchlist/remove",
        body: { movies: [{ ids: { imdb: MOVIE } }] },
        token: "access-token",
      },
    ]);
  });

  it("adds the whole series to the watchlist from an episode", async () => {
    const account = seedActionAccount();

    await app.request(
      `/${account.id}/actions/watchlist/add/series/${SERIES}%3A2%3A5`,
    );

    expect(traktWrites()).toEqual([
      {
        path: "/sync/watchlist",
        body: { shows: [{ ids: { imdb: SERIES } }] },
        token: "access-token",
      },
    ]);
  });

  it("marks one episode as watched", async () => {
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watched/add/series/${SERIES}%3A2%3A5`,
    );

    expect(await res.text()).toContain(
      "The Title S02E05 is marked as watched on Trakt",
    );
    expect(traktWrites()).toEqual([
      {
        path: "/sync/history",
        body: {
          shows: [
            {
              ids: { imdb: SERIES },
              seasons: [{ number: 2, episodes: [{ number: 5 }] }],
            },
          ],
        },
        token: "access-token",
      },
    ]);
  });

  it("says which Provider failed", async () => {
    trakt.fail("/sync/history/remove", 502);
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watched/remove/movie/${MOVIE}`,
    );

    const html = await res.text();
    expect(html).toContain("Something went wrong");
    expect(html).toContain("It did not work on Trakt.");
  });

  it("says what to do when no connected account can do the Action", async () => {
    const account = seedActionAccount({ enabled: false });

    const res = await app.request(
      `/${account.id}/actions/watchlist/add/movie/${MOVIE}`,
    );

    const html = await res.text();
    expect(html).not.toContain("Something went wrong");
    expect(html).toContain("No connected account can do this");
    expect(html).toContain("Stremlist configure page");
    expect(traktWrites()).toEqual([]);
  });

  it.each([
    `watchlist/toggle/movie/${MOVIE}`,
    `watchlist/add/channel/${MOVIE}`,
    `delete/add/movie/${MOVIE}`,
    `watched/add/series/${SERIES}%`,
  ])("refuses the malformed Action %s", async (path) => {
    const account = seedActionAccount();

    const res = await app.request(`/${account.id}/actions/${path}`);

    expect(res.status).toBe(404);
    expect(traktWrites()).toEqual([]);
  });

  it("refuses a Legacy alias", async () => {
    const legacy = seedActionAccount({ legacy: true });

    for (const key of ["ur12345678", legacy.id]) {
      const res = await app.request(
        `/${key}/actions/watchlist/add/movie/${MOVIE}`,
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This link does not work");
    }
    expect(traktWrites()).toEqual([]);
  });

  describe("rating", () => {
    it("shows a form with the current rating and each Provider", async () => {
      const account = seedActionAccount({ providers: ["trakt", "simkl"] });
      seedMembership(account.id, "trakt", { ratings: { [MOVIE]: 7 } });

      const res = await app.request(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Rate The Title");
      expect(html.match(/type="radio"/g)).toHaveLength(10);
      expect(html).toMatch(/value="7"[^>]*checked/);
      expect(html).toContain('value="trakt"');
      expect(html).toContain('value="simkl"');
      expect(html).toContain("Now 7/10");
      expect(html).toContain("Not rated");
      expect(html).toContain("Remove rating");
      expect(traktWrites()).toEqual([]);
      expect(simklWrites()).toEqual([]);
    });

    it("hides the remove button when nothing is rated", async () => {
      const account = seedActionAccount();

      const html = await (
        await app.request(`/${account.id}/actions/rating/rate/series/${SERIES}`)
      ).text();

      expect(html).toContain("Rate The Title");
      expect(html).not.toContain("Remove rating");
    });

    it("answers 404 when no Provider can rate", async () => {
      const account = seedActionAccount({ providers: ["justwatch"] });

      const res = await app.request(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
      );

      expect(res.status).toBe(404);
    });

    it("sends the rating to the chosen Providers only", async () => {
      const account = seedActionAccount({ providers: ["trakt", "simkl"] });

      const res = await postForm(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
        [
          ["rating", "8"],
          ["providers", "trakt"],
          ["providers", "netflix"],
        ],
      );

      expect(await res.text()).toContain("The Title is rated 8/10 on Trakt");
      expect(traktWrites()).toEqual([
        {
          path: "/sync/ratings",
          body: { movies: [{ ids: { imdb: MOVIE }, rating: 8 }] },
          token: "access-token",
        },
      ]);
      expect(simklWrites()).toEqual([]);
    });

    it("asks again for an account when none is ticked, and keeps the rating", async () => {
      const account = seedActionAccount({ providers: ["trakt", "simkl"] });

      const res = await postForm(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
        [["rating", "8"]],
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Something went wrong");
      expect(html).toContain("Rate The Title");
      expect(html).toContain("Choose at least one account");
      expect(html).toMatch(/value="8"[^>]*checked/);
      expect(html).not.toMatch(/value="trakt"[^>]*checked/);
      expect(traktWrites()).toEqual([]);
      expect(simklWrites()).toEqual([]);
    });

    it("removes the rating", async () => {
      const account = seedActionAccount();

      const res = await postForm(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
        [
          ["remove", "1"],
          ["providers", "trakt"],
        ],
      );

      expect(await res.text()).toContain(
        "The Title has no rating on Trakt now",
      );
      expect(traktWrites()).toEqual([
        {
          path: "/sync/ratings/remove",
          body: { movies: [{ ids: { imdb: MOVIE } }] },
          token: "access-token",
        },
      ]);
    });

    it.each(["0", "11", "7.5", "abc"])(
      "shows the form again for the invalid rating %j",
      async (rating) => {
        const account = seedActionAccount();

        const res = await postForm(
          `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
          [
            ["rating", rating],
            ["providers", "trakt"],
          ],
        );

        expect(await res.text()).toContain("Rate The Title");
        expect(traktWrites()).toEqual([]);
      },
    );

    it("refuses a Legacy alias", async () => {
      seedActionAccount({ legacy: true });

      const res = await postForm(
        `/ur12345678/actions/rating/rate/movie/${MOVIE}`,
        [
          ["rating", "8"],
          ["providers", "trakt"],
        ],
      );

      expect(res.status).toBe(404);
      expect(traktWrites()).toEqual([]);
    });
  });
});
