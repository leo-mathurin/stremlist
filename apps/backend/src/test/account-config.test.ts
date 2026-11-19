import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  getConfig,
  legacyAccountId,
  OTHER_IMDB,
  OWNER,
  postConfig,
  postJson,
  resetConfigTest,
  rpcArgs,
  seedWatchlist,
  UUID_1,
  UUID_2,
} from "./helpers/config-api.js";
import {
  movie,
  seedAccount,
  seedConnection,
  seedList,
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import {
  FakeLetterboxd,
  LETTERBOXD,
  letterboxdPage,
} from "./helpers/letterboxd.test-utils.js";
import { db, rpcCalls, rpcCallsOf } from "./helpers/mock-supabase.js";
import { configBody, errorBody, readJson } from "./helpers/json.js";
import { unexpectedRequest, useMswServer } from "./helpers/msw.test-utils.js";
import { FakeTrakt, useTraktApp } from "./helpers/trakt.test-utils.js";

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();
const trakt = new FakeTrakt();
const letterboxd = new FakeLetterboxd();

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
  server.use(
    imdb.handler,
    trakt.handler,
    ...letterboxd.handlers,
    cinemetaWithoutTitles,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function serveImdbProfiles(userIds: Record<string, string | null>) {
  const handles: string[] = [];
  server.use(
    http.get("https://www.imdb.com/user/:handle/", ({ params, request }) => {
      const handle = String(params.handle);
      handles.push(handle);
      if (!Object.hasOwn(userIds, handle)) return unexpectedRequest(request);
      const userId = userIds[handle];
      return userId
        ? HttpResponse.html(`<script>{"userId":"${userId}"}</script>`)
        : new HttpResponse("Not Found", { status: 404 });
    }),
  );
  return handles;
}

describe("List CRUD via the config API", () => {
  it.each([
    { minRating: 11 },
    { maxRuntime: -1 },
    { decade: 1995 },
    { genre: "" },
  ])("rejects invalid catalog settings %j", async (catalogSettings) => {
    seedWatchlist({ id: UUID_1 });
    const response = await postConfig(OWNER, {
      lists: [
        {
          id: UUID_1,
          sourceRef: OWNER,
          sortOption: "title-asc",
          catalogSettings,
        },
      ],
    });
    expect(response.status).toBe(400);
  });

  describe("GET /:accountKey/config", () => {
    it.each([
      ["an unknown Legacy alias", "ur99999999", 404],
      ["an unknown Account ID", "sl_0000000000000000000000", 404],
      ["a key that is not an Addon URL key", "YOUR_IMDB_ID", 400],
      ["an unknown list ID Legacy alias", "ls123456789", 404],
    ])("refuses %s", async (_, key, status) => {
      expect((await getConfig(key)).status).toBe(status);
    });

    it("returns empty lists when none exist", async () => {
      const res = await getConfig(OWNER);
      expect(res.status).toBe(200);
      const data = await readJson(res, configBody);
      expect(data.lists).toEqual([]);
      expect(data.rpdbApiKey).toBeNull();
      expect(typeof data.lastFetchedAt).toBe("string");
    });

    it("returns existing lists with their IDs, sorted by position", async () => {
      seedWatchlist({
        id: UUID_2,
        sourceRef: OTHER_IMDB,
        catalogTitle: "Friend",
        position: 1,
      });
      seedWatchlist({ id: UUID_1, catalogTitle: "Movies" });

      const data = await readJson(await getConfig(OWNER), configBody);

      expect(data.lists).toMatchObject([
        {
          id: UUID_1,
          provider: "imdb",
          sourceRef: OWNER,
          catalogTitle: "Movies",
        },
        {
          id: UUID_2,
          provider: "imdb",
          sourceRef: OTHER_IMDB,
          catalogTitle: "Friend",
        },
      ]);
    });

    it("hides the Account ID, Connections and Connection lists from a Legacy alias", async () => {
      seedWatchlist({ id: UUID_1 });
      seedWatchlist({
        id: UUID_2,
        provider: "trakt",
        sourceRef: "me/watchlist",
        position: 1,
      });
      seedConnection(legacyAccountId, "trakt");

      const data = await readJson(await getConfig(OWNER), configBody);

      expect(data.access).toBe("legacy");
      expect(data.accountId).toBeNull();
      expect(data.connections).toEqual([]);
      expect(data.lists.map((list: { id: string }) => list.id)).toEqual([
        UUID_1,
      ]);
      expect(JSON.stringify(data)).not.toContain(legacyAccountId);
    });

    it("returns everything to the private Addon URL", async () => {
      const account = seedAccount({
        actions_enabled: true,
        action_providers: ["trakt"],
      });
      seedWatchlist({ id: UUID_1, accountId: account.id });
      seedWatchlist({
        id: UUID_2,
        accountId: account.id,
        provider: "trakt",
        sourceRef: "me/watchlist",
        position: 1,
      });
      seedConnection(account.id, "trakt", { username: "leo" });

      const data = await readJson(await getConfig(account.id), configBody);

      expect(data).toMatchObject({
        access: "private",
        accountId: account.id,
        actions: { enabled: true, providers: ["trakt"] },
        connections: [{ provider: "trakt", username: "leo" }],
      });
      expect(data.lists.map((list: { id: string }) => list.id)).toEqual([
        UUID_1,
        UUID_2,
      ]);
      expect(JSON.stringify(data)).not.toContain("access_token");
      expect(JSON.stringify(data)).not.toContain("v1:");
    });

    it("does not open an Account through its internal ID when it has a Legacy alias", async () => {
      const res = await getConfig(legacyAccountId);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:accountKey/config", () => {
    it("returns 404 for an unknown Addon URL", async () => {
      const res = await postConfig("ur99999999", {
        lists: [{ sourceRef: "ur99999999", sortOption: "added_at-asc" }],
      });
      expect(res.status).toBe(404);
    });

    it("rejects duplicate Source lists", async () => {
      const res = await postConfig(OWNER, {
        lists: [
          { sourceRef: OWNER, sortOption: "added_at-asc" },
          { sourceRef: OWNER, sortOption: "year-asc" },
        ],
      });

      expect(res.status).toBe(400);
      const data = await readJson(res, errorBody);
      expect(data.error).toBe("Each list can only be added once.");
      expect(rpcCalls).toEqual([]);
      expect(background.scheduled).toBe(0);
    });

    it("allows the same reference on two different Providers", async () => {
      trakt.serve("/lists/123/items", []);
      const res = await postConfig(OWNER, {
        lists: [
          {
            sourceRef: "lists/123",
            provider: "trakt",
            sortOption: "added_at-asc",
          },
          { sourceRef: OWNER, sortOption: "added_at-asc" },
        ],
      });
      expect(res.status).toBe(200);
    });

    it.each<[string, Record<string, unknown>[]]>([
      ["no list", []],
      [
        "an invalid sort option",
        [{ sourceRef: OWNER, sortOption: "invalid-sort" }],
      ],
      [
        "an unknown Provider",
        [{ provider: "netflix", sourceRef: OWNER, sortOption: "added_at-asc" }],
      ],
      [
        "more than 50 lists",
        Array.from({ length: 51 }, (_, i) => ({
          sourceRef: `ur${String(10000000 + i)}`,
          sortOption: "added_at-asc",
        })),
      ],
    ])("rejects %s", async (_, lists) => {
      const res = await postJson(`/${OWNER}/config`, {
        lists: lists.map((list) => ({ provider: "imdb", ...list })),
      });
      expect(res.status).toBe(400);
    });

    it.each(["invalid", "tt0111161", "https://example.com/ur12345678"])(
      "rejects the invalid IMDb reference %j",
      async (sourceRef) => {
        const res = await postConfig(OWNER, {
          lists: [{ sourceRef, sortOption: "added_at-asc" }],
        });
        expect(res.status).toBe(400);
        expect(rpcCalls).toEqual([]);
      },
    );

    it.each(["ls123456789", "imdb:top-rated-movies"])(
      "accepts the IMDb reference %j",
      async (sourceRef) => {
        imdb.fail("ChartTitles");
        const res = await postConfig(OWNER, {
          lists: [{ sourceRef, sortOption: "added_at-asc" }],
        });
        expect(res.status).toBe(200);
        expect(rpcArgs().p_lists).toEqual([
          expect.objectContaining({ provider: "imdb", source_ref: sourceRef }),
        ]);
      },
    );

    it("accepts a public Letterboxd Source list", async () => {
      letterboxd.serve(`${LETTERBOXD}/leo/watchlist/`, letterboxdPage([]));
      const res = await postConfig(OWNER, {
        lists: [
          {
            provider: "letterboxd",
            sourceRef: "users/leo/watchlist",
            sortOption: "added_at-asc",
          },
        ],
      });
      expect(res.status).toBe(200);
      expect(rpcArgs().p_lists).toEqual([
        expect.objectContaining({
          provider: "letterboxd",
          source_ref: "users/leo/watchlist",
        }),
      ]);
    });

    it.each(["lbxshare/leo/list/x/share/TOK", "lbxshort/YtpP8$TOK"])(
      "refuses to save a provisional Letterboxd reference %j with its plaintext token",
      async (sourceRef) => {
        const res = await postConfig(OWNER, {
          lists: [
            { provider: "letterboxd", sourceRef, sortOption: "added_at-asc" },
          ],
        });
        expect(res.status).toBe(400);
      },
    );

    it("turns IMDb p. handles into user IDs before saving", async () => {
      const handles = serveImdbProfiles({ "p.leo123": OTHER_IMDB });

      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: "p.leo123", sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(200);
      expect(handles).toEqual(["p.leo123"]);
      expect(rpcArgs().p_lists).toEqual([
        expect.objectContaining({ source_ref: OTHER_IMDB }),
      ]);
    });

    it("rejects a p. handle that resolves to a list already added", async () => {
      serveImdbProfiles({ "p.owner": OWNER });

      const res = await postConfig(OWNER, {
        lists: [
          { sourceRef: OWNER, sortOption: "added_at-asc" },
          { sourceRef: "p.owner", sortOption: "added_at-asc" },
        ],
      });

      expect(res.status).toBe(400);
      expect((await readJson(res, errorBody)).error).toBe(
        "Each list can only be added once.",
      );
    });

    it("rejects a p. handle that IMDb cannot resolve", async () => {
      serveImdbProfiles({ "p.nobody": null });

      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: "p.nobody", sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(400);
      expect((await readJson(res, errorBody)).error).toContain('"p.nobody"');
    });

    it("does not ask IMDb to resolve a p. handle while IMDb is turned off", async () => {
      const handles = serveImdbProfiles({ "p.leo123": OTHER_IMDB });
      vi.stubEnv("DISABLED_PROVIDERS", "imdb");

      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: "p.leo123", sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(400);
      expect((await readJson(res, errorBody)).error).toBe(
        "IMDb is temporarily unavailable. Please try again later.",
      );
      expect(handles).toEqual([]);
    });

    it("does not let a Legacy alias turn Actions on", async () => {
      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
        actions: { enabled: true, providers: ["trakt"] },
      });

      expect(res.status).toBe(400);
      expect(rpcCalls).toEqual([]);
    });

    it("ignores Action settings that a Legacy alias sends turned off", async () => {
      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
        actions: { enabled: false, providers: [] },
      });

      expect(res.status).toBe(200);
      expect(rpcArgs().p_actions_enabled).toBeNull();
      expect(rpcArgs().p_action_providers).toBeNull();
    });

    it.each([
      ["trakt", "me/watchlist"],
      ["simkl", "me/plantowatch"],
      ["mdblist", "lists/leo/top"],
    ] as const)(
      "does not let a Legacy alias add the Connection list %s %s",
      async (provider, sourceRef) => {
        seedConnection(legacyAccountId, provider);

        const res = await postConfig(OWNER, {
          lists: [{ provider, sourceRef, sortOption: "added_at-asc" }],
        });

        expect(res.status).toBe(400);
        expect((await readJson(res, errorBody)).error).toContain(
          "private Addon URL",
        );
      },
    );

    it.each([
      ["trakt", "me/watchlist", "Trakt"],
      ["simkl", "me/plantowatch", "Simkl"],
    ] as const)(
      "rejects the Connection list %s %s without a Connection",
      async (provider, sourceRef, label) => {
        const account = seedAccount();

        const res = await postConfig(account.id, {
          lists: [{ provider, sourceRef, sortOption: "added_at-asc" }],
        });

        expect(res.status).toBe(400);
        expect((await readJson(res, errorBody)).error).toBe(
          `Connect your ${label} account first.`,
        );
      },
    );

    it("keeps a saved Connection list after a disconnect, so other settings still save", async () => {
      const account = seedAccount();
      const saved = seedList(account.id, {
        provider: "trakt",
        source_ref: "me/watchlist",
        position: 0,
      });

      const res = await postConfig(account.id, {
        lists: [
          {
            id: saved.id,
            provider: "trakt",
            sourceRef: "me/watchlist",
            sortOption: "added_at-asc",
          },
          { sourceRef: OWNER, sortOption: "added_at-asc" },
        ],
      });

      expect(res.status).toBe(200);
      expect(db.getTable("lists")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: saved.id, source_ref: "me/watchlist" }),
          expect.objectContaining({ provider: "imdb", source_ref: OWNER }),
        ]),
      );
    });

    it("saves a Connection list once the Account has the Connection", async () => {
      const account = seedAccount();
      seedConnection(account.id, "trakt", { accessToken: "token-of-account" });
      trakt.serve("/users/me/watchlist", []);

      const res = await postConfig(account.id, {
        lists: [
          {
            provider: "trakt",
            sourceRef: "me/watchlist",
            sortOption: "added_at-asc",
          },
        ],
      });

      expect(res.status).toBe(200);
      expect(db.getTable("lists")).toEqual([
        expect.objectContaining({
          account_id: account.id,
          provider: "trakt",
          source_ref: "me/watchlist",
        }),
      ]);
      await background.settle();
      expect(
        rpcCallsOf("request_list_prewarm").map((args) => args.p_account_id),
      ).toEqual([account.id]);
      expect(
        trakt.requestsOf("/users/me/watchlist").map((request) => request.token),
      ).toEqual(["token-of-account"]);
    });

    it.each([
      ["tmdb", ["tt0111161"]],
      ["imdb", []],
    ])(
      "prewarms the posters of the %s poster source that the Account chose",
      async (posterSource, finds) => {
        vi.stubEnv("TMDB_API_KEY", "test-tmdb-key");
        vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "");
        const tmdbFinds: string[] = [];
        server.use(
          http.get("https://api.themoviedb.org/3/find/:id", ({ params }) => {
            tmdbFinds.push(String(params.id));
            return HttpResponse.json({
              movie_results: [{ poster_path: "/poster.jpg" }],
              tv_results: [],
            });
          }),
        );
        const account = seedAccount({ poster_source: posterSource });
        seedConnection(account.id, "trakt", {
          accessToken: "token-of-account",
        });
        const title = movie("tt0111161", { name: "The Shawshank Redemption" });
        imdb.titles.set(title.id, title);
        trakt.serve("/users/me/watchlist", [title]);

        const res = await postConfig(account.id, {
          lists: [
            {
              provider: "trakt",
              sourceRef: "me/watchlist",
              sortOption: "added_at-asc",
            },
          ],
        });

        expect(res.status).toBe(200);
        await background.settle();
        expect(
          rpcCallsOf("request_list_prewarm").map((args) => args.p_account_id),
        ).toEqual([account.id]);
        expect(tmdbFinds).toEqual(finds);
      },
    );

    it("keeps only connected Action Providers that support Actions", async () => {
      const account = seedAccount();
      seedConnection(account.id, "trakt");
      seedConnection(account.id, "justwatch");

      const res = await postConfig(account.id, {
        lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
        actions: {
          enabled: true,
          providers: ["trakt", "justwatch", "mdblist", "trakt"],
        },
      });

      expect(res.status).toBe(200);
      expect(rpcArgs().p_actions_enabled).toBe(true);
      expect(rpcArgs().p_action_providers).toEqual(["trakt"]);
      expect(db.getTable("accounts")[1]).toMatchObject({
        actions_enabled: true,
        action_providers: ["trakt"],
      });
    });
  });
});
