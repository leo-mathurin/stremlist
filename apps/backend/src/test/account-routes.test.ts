import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import app from "../index.js";
import * as listPrewarm from "../services/list-prewarm";
import {
  getConfig,
  getProvider,
  legacyAccountId,
  OWNER,
  postJson,
  resetConfigTest,
  seedWatchlist,
  UUID_1,
  UUID_2,
  withProviders,
} from "./helpers/config-api.js";
import {
  movie,
  seedAccount,
  seedConnection,
  seedList,
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import { cache } from "./helpers/list-cache.test-utils.js";
import { db, rpcCallsOf } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { r2Objects, r2Undeletable } from "./helpers/r2.test-utils.js";
import { FakeTrakt, useTraktApp } from "./helpers/trakt.test-utils.js";
import {
  accountIdBody,
  configBody,
  createdAccountBody,
  readJson,
  stremioManifest,
} from "./helpers/json.js";

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();
const trakt = new FakeTrakt();

beforeEach(() => {
  useTraktApp();
  resetConfigTest();
  imdb.reset();
  trakt.reset();
  server.use(
    imdb.handler,
    trakt.handler,
    cinemetaWithoutTitles,
    http.post("https://auth.trakt.tv/oauth/revoke", () =>
      HttpResponse.json({}),
    ),
    http.post("https://api.simkl.com/oauth2/revoke", () =>
      HttpResponse.json({}),
    ),
  );
});

afterEach(async () => {
  await background.settle();
  vi.unstubAllEnvs();
});

function prewarmedAccounts() {
  return rpcCallsOf("request_list_prewarm").map((args) => args.p_account_id);
}

function watchPrewarm() {
  return vi.spyOn(listPrewarm, "prewarmLists");
}

function expectRpdbPrewarm(
  prewarm: ReturnType<typeof watchPrewarm>,
  accountId: string,
) {
  expect(prewarm).toHaveBeenCalledWith(
    accountId,
    expect.any(Array),
    true,
    expect.objectContaining({ posterSource: "rpdb", rpdbApiKey: "rpdb" }),
  );
}

function watchlistReads() {
  return imdb
    .requestsOf("WatchListPage")
    .map(({ variables }) => variables.urConst);
}

function createAccount(body: Parameters<typeof withProviders>[0]) {
  return postJson("/accounts", withProviders(body));
}

function disconnect(accountId: string, provider: string) {
  return app.request(`/${accountId}/connections/${provider}`, {
    method: "DELETE",
  });
}

describe("List CRUD via the config API", () => {
  describe("POST /accounts", () => {
    it("creates an Account with a private ID and its first Lists", async () => {
      const prewarm = watchPrewarm();
      const res = await createAccount({
        rpdbApiKey: "rpdb",
        lists: [
          {
            sourceRef: OWNER,
            sortOption: "added_at-asc",
            catalogTitle: "Mine",
          },
          { sourceRef: "imdb:top-rated-movies", sortOption: "rating-desc" },
        ],
      });

      expect(res.status).toBe(200);
      const data = await readJson(res, createdAccountBody);
      expect(data.ok).toBe(true);
      expect(data.accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
      expect(
        data.lists.map((list: { sourceRef: string }) => list.sourceRef),
      ).toEqual([OWNER, "imdb:top-rated-movies"]);
      expect(data.lists[1].catalogTitle).toBe("");

      const created = db
        .getTable("accounts")
        .find((row) => row.id === data.accountId);
      expect(created).toMatchObject({
        legacy_imdb_user_id: null,
        rpdb_api_key: "rpdb",
      });
      expect(
        db.getTable("lists").filter((row) => row.account_id === data.accountId),
      ).toHaveLength(2);

      await background.settle();
      expect(prewarmedAccounts()).toEqual([data.accountId]);
      expect(watchlistReads()).toEqual([OWNER]);
      expectRpdbPrewarm(prewarm, data.accountId);

      const config = await readJson(
        await getConfig(data.accountId),
        configBody,
      );
      expect(config.access).toBe("private");
    });

    it("creates an Account without Lists, so Simkl users can connect first", async () => {
      const res = await postJson("/accounts", { lists: [] });

      expect(res.status).toBe(200);
      const data = await readJson(res, createdAccountBody);
      expect(data.accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
      expect(data.lists).toEqual([]);

      const manifest = await readJson(
        await app.request(`/${data.accountId}/manifest.json`),
        stremioManifest,
      );
      expect(manifest.catalogs).toEqual([]);
    });

    it.each([
      [
        "Connection lists: a new Account has no Connection yet",
        [
          {
            provider: "trakt" as const,
            sourceRef: "me/watchlist",
            sortOption: "added_at-asc",
          },
        ],
      ],
      [
        "duplicates",
        [
          { sourceRef: OWNER, sortOption: "added_at-asc" },
          { sourceRef: OWNER, sortOption: "title-asc" },
        ],
      ],
    ])("rejects %s without creating an Account", async (_, lists) => {
      const res = await createAccount({ lists });

      expect(res.status).toBe(400);
      expect(db.getTable("accounts")).toHaveLength(1);
    });
  });
});

describe("a caller who knows only the Legacy alias", () => {
  it("cannot freeze the legacy install", async () => {
    seedWatchlist({ id: UUID_1, catalogTitle: "Mine" });

    await app.request(`/${OWNER}/upgrade`, { method: "POST" });
    const shown = await readJson(await getConfig(OWNER), configBody);
    expect((await postJson("/accounts", { lists: shown.lists })).status).toBe(
      200,
    );

    const save = await postJson(`/${OWNER}/config`, {
      lists: [
        {
          id: UUID_1,
          provider: "imdb",
          sourceRef: OWNER,
          catalogTitle: "Still mine",
          sortOption: "added_at-desc",
        },
      ],
    });
    expect(save.status).toBe(200);
    const legacy = await readJson(await getConfig(OWNER), configBody);
    expect(
      legacy.lists.map((list: { catalogTitle: string }) => list.catalogTitle),
    ).toEqual(["Still mine"]);
    expect(legacy).not.toHaveProperty("movedAt", expect.any(String));
  });
});

describe("upgrading a legacy install", () => {
  it("creates a new private Account from the setup the legacy page shows", async () => {
    const prewarm = watchPrewarm();
    db.getTable("accounts")[0].rpdb_api_key = "rpdb";
    seedWatchlist({ id: UUID_1, catalogTitle: "Mine" });
    seedWatchlist({ id: UUID_2, sourceRef: "ls123456789", position: 1 });
    const legacy = await readJson(await getConfig(OWNER), configBody);

    const res = await postJson("/accounts", {
      rpdbApiKey: legacy.rpdbApiKey,
      lists: legacy.lists.map((list: { catalogTitle: string }, index: number) =>
        index === 1 ? { ...list, catalogTitle: "Edited" } : list,
      ),
    });

    expect(res.status).toBe(200);
    const { accountId } = await readJson(res, accountIdBody);
    expect(accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
    expect(accountId).not.toBe(legacyAccountId);

    const copy = await readJson(await getConfig(accountId), configBody);
    expect(copy).toMatchObject({ access: "private", rpdbApiKey: "rpdb" });
    expect(
      copy.lists.map((list: { sourceRef: string; catalogTitle: string }) => [
        list.sourceRef,
        list.catalogTitle,
      ]),
    ).toEqual([
      [OWNER, "Mine"],
      ["ls123456789", "Edited"],
    ]);
    expect(copy.lists.map((list: { id: string }) => list.id)).not.toContain(
      UUID_1,
    );

    const after = await readJson(await getConfig(OWNER), configBody);
    expect(
      after.lists.map((list: { catalogTitle: string }) => list.catalogTitle),
    ).toEqual(["Mine", ""]);
    expect(after).not.toHaveProperty("movedAt");

    await background.settle();
    expect(prewarmedAccounts()).toEqual([accountId]);
    expect(watchlistReads()).toEqual([OWNER]);
    expectRpdbPrewarm(prewarm, accountId);
  });

  it("has no route that changes the legacy install through its alias alone", async () => {
    const res = await app.request(`/${OWNER}/upgrade`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:accountId/connections/:provider", () => {
  it("stops serving and storing what was read through the Connection", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    const privateList = seedList(account.id, {
      provider: "trakt",
      source_ref: "me/watchlist",
    });
    const publicList = seedList(account.id, {
      provider: "trakt",
      source_ref: "users/leo/watchlist",
      position: 1,
    });
    cache.seed(privateList.id, [movie("tt0111161")]);
    cache.seed(publicList.id, [movie("tt0111161")]);
    for (const list of [privateList, publicList]) {
      db.insert("list_sync_status", {
        list_id: list.id,
        provider: "trakt",
        source_ref: list.source_ref,
        last_attempt_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        title_count: 1,
      });
    }
    r2Objects.set(`connections/${account.id}/trakt/membership.json`, "{}");

    const res = await disconnect(account.id, "trakt");

    expect(res.status).toBe(200);
    expect(db.getTable("connections")).toEqual([]);
    expect(cache.get(privateList.id)).toBeNull();
    expect(cache.get(publicList.id)).not.toBeNull();
    expect(db.getTable("list_sync_status").map((row) => row.list_id)).toEqual([
      publicList.id,
    ]);
    expect(
      r2Objects.has(`connections/${account.id}/trakt/membership.json`),
    ).toBe(false);
  });

  it("deletes every object the Connection stored, also private list snapshots", async () => {
    const forgetConnection = vi.spyOn(getProvider("simkl"), "forgetConnection");
    const account = seedAccount();
    const other = seedAccount();
    seedConnection(account.id, "simkl");
    const own = [
      "membership.json",
      "library.json",
      "lists/1.json",
      "lists/2.json",
      "lists/3.json",
    ].map((name) => `connections/${account.id}/simkl/${name}`);
    const kept = [
      `connections/${account.id}/trakt/membership.json`,
      `connections/${other.id}/simkl/lists/1.json`,
    ];
    for (const key of [...own, ...kept]) r2Objects.set(key, "{}");

    const res = await disconnect(account.id, "simkl");

    expect(res.status).toBe(200);
    expect(own.filter((key) => r2Objects.has(key))).toEqual([]);
    expect(kept.filter((key) => r2Objects.has(key))).toEqual(kept);
    expect(forgetConnection).toHaveBeenCalledWith(account.id);
  });

  it("logs the objects that the store could not delete", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    const key = `connections/${account.id}/trakt/membership.json`;
    r2Objects.set(key, "{}");
    r2Undeletable.add(key);
    const logged = vi.spyOn(console, "error");

    const res = await disconnect(account.id, "trakt");

    expect(res.status).toBe(200);
    expect(db.getTable("connections")).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      `Cleaning up after the trakt disconnect of ${account.id} failed:`,
      expect.objectContaining({
        message: `Could not delete 1 objects under connections/${account.id}/trakt/`,
      }),
    );
  });
});
