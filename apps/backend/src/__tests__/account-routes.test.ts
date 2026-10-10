/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Tables } from "@stremlist/shared/database.types";
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

vi.mock("../lib/background", async () => {
  return (await import("./helpers/config-api-mocks.js")).backgroundMocks;
});
vi.mock("../services/list-prewarm", async () => {
  return (await import("./helpers/config-api-mocks.js")).prewarmMocks;
});

vi.mock("../lib/supabase", async () => {
  const { supabase } = await import("./helpers/mock-supabase.js");
  const { rpcMocks } = await import("./helpers/config-api-mocks.js");
  return { supabase: { ...supabase, rpc: rpcMocks.rpc } };
});

vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});

vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});

vi.mock("../lib/r2", async () => {
  return await import("./helpers/mock-r2.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import { prewarmMocks } from "./helpers/config-api-mocks.js";
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
import { seedAccount, seedConnection } from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { fakeAdapter, useFakeProvider } from "./helpers/mock-registry.js";
import { db } from "./helpers/mock-supabase.js";

beforeEach(resetConfigTest);

describe("List CRUD via the config API", () => {
  // ---- POST /accounts ----

  describe("POST /accounts", () => {
    it("creates an Account with a private ID and its first Lists", async () => {
      const res = await postJson(
        "/accounts",
        withProviders({
          rpdbApiKey: "rpdb",
          lists: [
            {
              sourceRef: OWNER,
              sortOption: "added_at-asc",
              catalogTitle: "Mine",
            },
            { sourceRef: "imdb:top-rated-movies", sortOption: "rating-desc" },
          ],
        }),
      );

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

    it("rejects Connection lists: a new Account has no Connection yet", async () => {
      const res = await postJson(
        "/accounts",
        withProviders({
          lists: [
            {
              provider: "trakt",
              sourceRef: "me/watchlist",
              sortOption: "added_at-asc",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(db.getTable("accounts")).toHaveLength(1);
    });

    it("rejects duplicates without creating an Account", async () => {
      const res = await postJson(
        "/accounts",
        withProviders({
          lists: [
            { sourceRef: OWNER, sortOption: "added_at-asc" },
            { sourceRef: OWNER, sortOption: "title-asc" },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(db.getTable("accounts")).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Upgrade from a Legacy alias
// ---------------------------------------------------------------------------

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

  it("refuses a private Addon URL", async () => {
    const account = seedAccount();
    const res = await app.request(`/${account.id}/upgrade`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown Legacy alias", async () => {
    const res = await app.request(`/ur99999999/upgrade`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:accountId/connections/:provider", () => {
  it("stops serving and storing what was read through the Connection", async () => {
    const { r2Objects } = await import("./helpers/mock-r2.js");
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    const privateList = db.insert("lists", {
      account_id: account.id,
      provider: "trakt",
      source_ref: "me/watchlist",
      catalog_title: "",
      position: 0,
    }) as Tables<"lists">;
    const publicList = db.insert("lists", {
      account_id: account.id,
      provider: "trakt",
      source_ref: "users/leo/watchlist",
      catalog_title: "",
      position: 1,
    }) as Tables<"lists">;
    const item = {
      id: "tt0111161",
      type: "movie" as const,
      name: "The Shawshank Redemption",
      poster: null,
      posterShape: "poster" as const,
      genres: [],
      description: "",
    };
    cache.seed(privateList.id, [item]);
    cache.seed(publicList.id, [item]);
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

    const res = await app.request(`/${account.id}/connections/trakt`, {
      method: "DELETE",
    });

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
    const { r2Objects } = await import("./helpers/mock-r2.js");
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

    const res = await app.request(`/${account.id}/connections/simkl`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(own.filter((key) => r2Objects.has(key))).toEqual([]);
    expect(kept.filter((key) => r2Objects.has(key))).toEqual(kept);
    // The adapter also forgets what it keeps in memory.
    expect(forgetConnection).toHaveBeenCalledWith(account.id);
  });
});
