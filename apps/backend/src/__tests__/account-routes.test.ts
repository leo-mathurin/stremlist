/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

const { backgroundMocks, prewarmMocks, supabaseMocks } = await vi.hoisted(
  () => import("./helpers/config-api-mocks.js"),
);
vi.mock("../lib/background", () => backgroundMocks);
vi.mock("../services/list-prewarm", () => prewarmMocks);
vi.mock("../lib/supabase", () => supabaseMocks);
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../providers/registry", () => import("./helpers/mock-registry.js"));
vi.mock("../lib/r2", () => import("./helpers/mock-r2.js"));
vi.mock("../lib/resend", () => import("./helpers/mock-resend.js"));

import {
  getConfig,
  legacyAccountId,
  OWNER,
  postJson,
  resetConfigTest,
  runScheduledTasks,
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
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { r2Objects, r2Undeletable } from "./helpers/mock-r2.js";
import { fakeAdapter, useFakeProvider } from "./helpers/mock-registry.js";
import { db } from "./helpers/mock-supabase.js";

beforeEach(resetConfigTest);

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
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
      expect(
        data.lists.map((list: { sourceRef: string }) => list.sourceRef),
      ).toEqual([OWNER, "imdb:top-rated-movies"]);
      expect(data.lists[1].catalogTitle).toBe("2");

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

      await runScheduledTasks();
      expect(prewarmMocks.prewarmLists).toHaveBeenCalledWith(
        data.accountId,
        expect.any(Array),
        true,
      );

      // The new Addon URL works right away.
      const config = await (await getConfig(data.accountId)).json();
      expect(config.access).toBe("private");
    });

    it("creates an Account without Lists, so Simkl users can connect first", async () => {
      const res = await postJson("/accounts", { lists: [] });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
      expect(data.lists).toEqual([]);

      // Its Addon URL already works: a manifest without catalogs.
      const manifest = await (
        await app.request(`/${data.accountId}/manifest.json`)
      ).json();
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

describe("POST /:accountKey/upgrade", () => {
  it("copies a legacy install into a new private Account", async () => {
    db.getTable("accounts")[0].rpdb_api_key = "rpdb";
    seedWatchlist({ id: UUID_1, catalogTitle: "Mine" });
    seedWatchlist({ id: UUID_2, sourceRef: "ls123456789", position: 1 });

    const res = await app.request(`/${OWNER}/upgrade`, { method: "POST" });

    expect(res.status).toBe(200);
    const { accountId } = await res.json();
    expect(accountId).toMatch(/^sl_[0-9A-Za-z]{22}$/);
    expect(accountId).not.toBe(legacyAccountId);

    const copy = await (await getConfig(accountId)).json();
    expect(copy).toMatchObject({ access: "private", rpdbApiKey: "rpdb" });
    expect(
      copy.lists.map((list: { sourceRef: string; catalogTitle: string }) => [
        list.sourceRef,
        list.catalogTitle,
      ]),
    ).toEqual([
      [OWNER, "Mine"],
      ["ls123456789", ""],
    ]);
    // New List IDs: the copy has its own Catalogs.
    expect(copy.lists.map((list: { id: string }) => list.id)).not.toContain(
      UUID_1,
    );

    // The old install keeps working and knows it moved.
    const legacy = await (await getConfig(OWNER)).json();
    expect(legacy.lists).toHaveLength(2);
    expect(typeof legacy.movedAt).toBe("string");

    await runScheduledTasks();
    expect(prewarmMocks.prewarmLists).toHaveBeenCalledWith(
      accountId,
      expect.any(Array),
      true,
    );
  });

  it.each([
    ["a private Addon URL", () => seedAccount().id, 400],
    ["an unknown Legacy alias", () => "ur99999999", 404],
  ])("refuses %s", async (_, key, status) => {
    const res = await app.request(`/${key()}/upgrade`, { method: "POST" });
    expect(res.status).toBe(status);
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
    // The private List's cache is gone; the public one stays.
    expect(cache.get(privateList.id)).toBeNull();
    expect(cache.get(publicList.id)).not.toBeNull();
    // Its old success no longer claims Titles that Stremio cannot show.
    expect(db.getTable("list_sync_status").map((row) => row.list_id)).toEqual([
      publicList.id,
    ]);
    expect(
      r2Objects.has(`connections/${account.id}/trakt/membership.json`),
    ).toBe(false);
  });

  it("deletes every object the Connection stored, also private list snapshots", async () => {
    const forgetConnection = vi.fn();
    useFakeProvider(fakeAdapter("simkl", { forgetConnection }));
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
    // The adapter also forgets what it keeps in memory.
    expect(forgetConnection).toHaveBeenCalledWith(account.id);
  });

  it("logs the objects that the store could not delete", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    const key = `connections/${account.id}/trakt/membership.json`;
    r2Objects.set(key, "{}");
    r2Undeletable.add(key);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await disconnect(account.id, "trakt");

    // The disconnect still succeeds; the stray object is not silent.
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
