/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { Database, Tables } from "@stremlist/shared/database.types";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";

type ReplaceConfig = Database["public"]["Functions"]["replace_account_config"];
interface RpcResult {
  data: unknown;
  error: unknown;
}
const rpcMocks = vi.hoisted(() => ({
  rpc: vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  >(),
}));

const backgroundMocks = vi.hoisted(() => ({
  scheduleBackgroundTask: vi.fn(),
}));
const prewarmMocks = vi.hoisted(() => ({
  prewarmLists: vi.fn(),
}));

vi.mock("../lib/background", () => backgroundMocks);
vi.mock("../services/list-prewarm", () => prewarmMocks);

vi.mock("../lib/supabase", async () => {
  const { supabase } = await import("./helpers/mock-supabase.js");
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

import * as scraper from "../services/imdb-scraper";
import {
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import {
  fakeActions,
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { callRpc, db } from "./helpers/mock-supabase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The legacy install of OWNER reaches its Account through the Legacy alias.
const OWNER = "ur12345678";
const OTHER_IMDB = "ur87654321";

const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

let legacyAccountId = "";

function seedWatchlist(overrides: {
  id: string;
  accountId?: string;
  provider?: ProviderId;
  sourceRef?: string;
  catalogTitle?: string;
  sortOption?: string;
  position?: number;
}) {
  seedList(overrides.accountId ?? legacyAccountId, {
    id: overrides.id,
    provider: overrides.provider ?? "imdb",
    source_ref: overrides.sourceRef ?? OWNER,
    catalog_title: overrides.catalogTitle ?? "",
    sort_option: overrides.sortOption ?? "added_at-asc",
    position: overrides.position ?? 0,
  });
}

interface ListBody {
  id?: string;
  provider?: ProviderId;
  sourceRef: string;
  catalogTitle?: string;
  sortOption: string;
  displayMode?: DisplayMode;
  position?: number;
  catalogSettings?: CatalogSettings;
}

interface ConfigBody {
  rpdbApiKey?: string;
  lists: ListBody[];
  actions?: { enabled: boolean; providers: ProviderId[] };
}

function withProviders(body: ConfigBody) {
  return {
    ...body,
    lists: body.lists.map((list) => ({ provider: "imdb", ...list })),
  };
}

function getConfig(accountKey: string) {
  return app.request(`/${accountKey}/config`);
}

function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postConfig(accountKey: string, body: ConfigBody) {
  return postJson(`/${accountKey}/config`, withProviders(body));
}

function rpcArgs(call = 0): ReplaceConfig["Args"] {
  return rpcMocks.rpc.mock.calls[call][1] as ReplaceConfig["Args"];
}

async function runScheduledTasks() {
  for (const [task] of backgroundMocks.scheduleBackgroundTask.mock.calls) {
    await (task as () => Promise<void>)();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  db.reset();
  rpcMocks.rpc.mockReset();
  rpcMocks.rpc.mockImplementation(callRpc);
  cache.reset();
  resetProviders();
  vi.restoreAllMocks();
  legacyAccountId = seedLegacyAccount(OWNER).id;
  backgroundMocks.scheduleBackgroundTask.mockReset();
  prewarmMocks.prewarmLists.mockReset();
  prewarmMocks.prewarmLists.mockResolvedValue(undefined);
});

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

  // ---- GET /:accountKey/config ----

  describe("GET /:accountKey/config", () => {
    it("returns 404 for an unknown Legacy alias", async () => {
      const res = await getConfig("ur99999999");
      expect(res.status).toBe(404);
    });

    it("returns 404 for an unknown Account ID", async () => {
      const res = await getConfig("sl_0000000000000000000000");
      expect(res.status).toBe(404);
    });

    it("returns 400 for a key that is not an Addon URL key", async () => {
      const res = await getConfig("ls123456789");
      expect(res.status).toBe(400);
    });

    it("returns empty lists when none exist", async () => {
      const res = await getConfig(OWNER);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.lists).toEqual([]);
      expect(data.rpdbApiKey).toBeNull();
      expect(typeof data.lastFetchedAt).toBe("string");
    });

    it("returns existing lists with their IDs", async () => {
      seedWatchlist({ id: UUID_1, catalogTitle: "Movies" });
      seedWatchlist({
        id: UUID_2,
        sourceRef: OTHER_IMDB,
        catalogTitle: "Friend",
        position: 1,
      });

      const res = await getConfig(OWNER);
      const data = await res.json();

      expect(data.lists).toHaveLength(2);
      expect(data.lists[0]).toMatchObject({
        id: UUID_1,
        provider: "imdb",
        sourceRef: OWNER,
        catalogTitle: "Movies",
      });
      expect(data.lists[1]).toMatchObject({
        id: UUID_2,
        provider: "imdb",
        sourceRef: OTHER_IMDB,
        catalogTitle: "Friend",
      });
    });

    it("returns lists sorted by position", async () => {
      seedWatchlist({
        id: UUID_2,
        sourceRef: OTHER_IMDB,
        position: 1,
        catalogTitle: "Second",
      });
      seedWatchlist({ id: UUID_1, position: 0, catalogTitle: "First" });

      const data = await getConfig(OWNER);
      const json = await data.json();
      expect(json.lists[0].catalogTitle).toBe("First");
      expect(json.lists[1].catalogTitle).toBe("Second");
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

      const data = await (await getConfig(OWNER)).json();

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

      const data = await (await getConfig(account.id)).json();

      expect(data).toMatchObject({
        access: "private",
        accountId: account.id,
        movedAt: null,
        actions: { enabled: true, providers: ["trakt"] },
        connections: [{ provider: "trakt", username: "leo" }],
      });
      expect(data.lists.map((list: { id: string }) => list.id)).toEqual([
        UUID_1,
        UUID_2,
      ]);
      // Tokens never leave the server.
      expect(JSON.stringify(data)).not.toContain("access_token");
      expect(JSON.stringify(data)).not.toContain("v1:");
    });

    it("does not open an Account through its internal ID when it has a Legacy alias", async () => {
      const res = await getConfig(legacyAccountId);
      expect(res.status).toBe(404);
    });
  });

  // ---- POST /:accountKey/config ----

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
      const data = await res.json();
      expect(data.error).toBe("Each list can only be added once.");
      expect(rpcMocks.rpc).not.toHaveBeenCalled();
      expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
    });

    it("allows the same reference on two different Providers", async () => {
      useFakeProvider(fakeAdapter("trakt"));
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

    it("rejects an empty list array", async () => {
      const res = await postConfig(OWNER, { lists: [] });
      expect(res.status).toBe(400);
    });

    it.each(["invalid", "tt0111161", "https://example.com/ur12345678"])(
      "rejects the invalid IMDb reference %j",
      async (sourceRef) => {
        const res = await postConfig(OWNER, {
          lists: [{ sourceRef, sortOption: "added_at-asc" }],
        });
        expect(res.status).toBe(400);
        expect(rpcMocks.rpc).not.toHaveBeenCalled();
      },
    );

    it.each(["ls123456789", "imdb:top-rated-movies"])(
      "accepts the IMDb reference %j",
      async (sourceRef) => {
        const res = await postConfig(OWNER, {
          lists: [{ sourceRef, sortOption: "added_at-asc" }],
        });
        expect(res.status).toBe(200);
        expect(rpcArgs().p_lists).toEqual([
          expect.objectContaining({ provider: "imdb", source_ref: sourceRef }),
        ]);
      },
    );

    it("rejects an invalid sort option", async () => {
      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: OWNER, sortOption: "invalid-sort" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects an unknown Provider", async () => {
      const res = await postJson(`/${OWNER}/config`, {
        lists: [
          { provider: "netflix", sourceRef: OWNER, sortOption: "added_at-asc" },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a Provider that is not available yet", async () => {
      const res = await postConfig(OWNER, {
        lists: [
          {
            provider: "letterboxd",
            sourceRef: "users/leo/watchlist",
            sortOption: "added_at-asc",
          },
        ],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Letterboxd is not available yet.");
    });

    it("rejects more than 10 lists", async () => {
      const lists = Array.from({ length: 11 }, (_, i) => ({
        sourceRef: `ur${String(10000000 + i)}`,
        sortOption: "added_at-asc",
      }));
      const res = await postConfig(OWNER, { lists });
      expect(res.status).toBe(400);
    });

    it("turns IMDb p. handles into user IDs before saving", async () => {
      const normalize = vi
        .spyOn(scraper, "normalizeImdbUserId")
        .mockImplementation((input) =>
          Promise.resolve(input === "p.leo123" ? OTHER_IMDB : input),
        );

      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: "p.leo123", sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(200);
      expect(normalize).toHaveBeenCalledWith("p.leo123");
      expect(rpcArgs().p_lists).toEqual([
        expect.objectContaining({ source_ref: OTHER_IMDB }),
      ]);
    });

    it("rejects a p. handle that resolves to a list already added", async () => {
      vi.spyOn(scraper, "normalizeImdbUserId").mockImplementation((input) =>
        Promise.resolve(input === "p.leo123" ? OWNER : input),
      );

      const res = await postConfig(OWNER, {
        lists: [
          { sourceRef: OWNER, sortOption: "added_at-asc" },
          { sourceRef: "p.leo123", sortOption: "added_at-asc" },
        ],
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "Each list can only be added once.",
      );
    });

    it("rejects a p. handle that IMDb cannot resolve", async () => {
      vi.spyOn(scraper, "normalizeImdbUserId").mockRejectedValue(
        new Error("not found"),
      );

      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: "p.nobody", sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('"p.nobody"');
    });

    it("tells a moved legacy install to use its private Addon URL (409)", async () => {
      db.getTable("accounts")[0].moved_at = new Date().toISOString();

      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ moved: true });
      expect(rpcMocks.rpc).not.toHaveBeenCalled();
    });

    it("does not let a Legacy alias turn Actions on", async () => {
      const res = await postConfig(OWNER, {
        lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
        actions: { enabled: true, providers: ["trakt"] },
      });

      expect(res.status).toBe(400);
      expect(rpcMocks.rpc).not.toHaveBeenCalled();
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
        expect((await res.json()).error).toContain("private Addon URL");
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
        expect((await res.json()).error).toBe(
          `Connect your ${label} account first.`,
        );
      },
    );

    it("saves a Connection list once the Account has the Connection", async () => {
      const account = seedAccount();
      seedConnection(account.id, "trakt");

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
      await runScheduledTasks();
      expect(prewarmMocks.prewarmLists).toHaveBeenCalledWith(
        account.id,
        expect.any(Array),
        true,
      );
    });

    it("keeps only connected Action Providers that support Actions", async () => {
      useFakeProvider(fakeAdapter("trakt", { actions: fakeActions() }));
      useFakeProvider(fakeAdapter("simkl"));
      const account = seedAccount();
      seedConnection(account.id, "trakt");
      seedConnection(account.id, "simkl");

      const res = await postConfig(account.id, {
        lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
        actions: {
          enabled: true,
          providers: ["trakt", "simkl", "mdblist", "trakt"],
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

  describe("configuration RPC boundary", () => {
    const savedRow: Tables<"lists"> = {
      id: UUID_1,
      account_id: "",
      provider: "imdb",
      source_ref: OWNER,
      catalog_title: "Saved title",
      sort_option: "rating-desc",
      display_mode: "split",
      position: 0,
      catalog_settings: { minRating: 8 },
      merged_sources: [],
      source_label: null,
      created_at: "2026-09-15T00:00:00Z",
      updated_at: "2026-09-15T00:00:00Z",
    };

    beforeEach(() => {
      rpcMocks.rpc.mockResolvedValue({
        data: [
          {
            deleted_ids: [],
            lists: [{ ...savedRow, account_id: legacyAccountId }],
          },
        ],
        error: null,
      });
    });

    it("sends normalized rows in one RPC and returns/prewarms the committed rows", async () => {
      const response = await postConfig(OWNER, {
        rpdbApiKey: "  secret-key  ",
        lists: [
          {
            id: UUID_1,
            sourceRef: OWNER,
            catalogTitle: "Updated",
            sortOption: "title-asc",
            position: 7,
          },
          { sourceRef: OTHER_IMDB, sortOption: "year-desc" },
        ],
      });
      expect(response.status).toBe(200);
      expect(rpcMocks.rpc).toHaveBeenCalledExactlyOnceWith(
        "replace_account_config",
        {
          p_account_id: legacyAccountId,
          p_rpdb_api_key: "secret-key",
          p_lists: [
            {
              id: UUID_1,
              provider: "imdb",
              source_ref: OWNER,
              catalog_title: "Updated",
              sort_option: "title-asc",
              display_mode: "split",
              position: 0,
              expected_merged_sources: [],
              source_label: null,
            },
            {
              provider: "imdb",
              source_ref: OTHER_IMDB,
              catalog_title: "2",
              sort_option: "year-desc",
              display_mode: "split",
              position: 1,
              merged_sources: [],
              source_label: null,
            },
          ],
          p_actions_enabled: null,
          p_action_providers: null,
        },
      );
      const expected = [
        {
          id: UUID_1,
          provider: "imdb",
          sourceRef: OWNER,
          catalogTitle: "Saved title",
          sortOption: "rating-desc",
          displayMode: "split",
          position: 0,
          catalogSettings: { minRating: 8 },
        },
      ];
      expect(await response.json()).toEqual({
        ok: true,
        lists: expected.map((row) => ({ ...row, availableGenres: [] })),
      });
      expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();
      await runScheduledTasks();
      // A Legacy alias never reads through a Connection, even when prewarming.
      expect(prewarmMocks.prewarmLists).toHaveBeenCalledExactlyOnceWith(
        legacyAccountId,
        expected,
        false,
      );
    });

    it("keeps omitted settings distinct from an explicit clear in the RPC payload", async () => {
      await postConfig(OWNER, {
        lists: [
          { id: UUID_1, sourceRef: OWNER, sortOption: "title-asc" },
          {
            id: UUID_2,
            sourceRef: OTHER_IMDB,
            sortOption: "title-desc",
            catalogSettings: {},
          },
        ],
      });
      expect(rpcArgs().p_lists).toEqual([
        {
          id: UUID_1,
          provider: "imdb",
          source_ref: OWNER,
          catalog_title: "1",
          sort_option: "title-asc",
          display_mode: "split",
          position: 0,
          expected_merged_sources: [],
          source_label: null,
        },
        {
          id: UUID_2,
          provider: "imdb",
          source_ref: OTHER_IMDB,
          catalog_title: "2",
          sort_option: "title-desc",
          display_mode: "split",
          position: 1,
          catalog_settings: {},
          expected_merged_sources: [],
          source_label: null,
        },
      ]);
    });

    it("passes combined filters, custom values and presets through unchanged", async () => {
      const catalogSettings: CatalogSettings = {
        genre: "Comedy",
        decade: 2090,
        maxRuntime: 95,
        minRating: 7.2,
        presets: ["short", "rated", "shuffle"],
      };
      const response = await postConfig(OWNER, {
        lists: [{ sourceRef: OWNER, sortOption: "title-asc", catalogSettings }],
      });
      expect(response.status).toBe(200);
      expect(rpcArgs().p_lists).toEqual([
        {
          provider: "imdb",
          source_ref: OWNER,
          catalog_title: "",
          sort_option: "title-asc",
          display_mode: "split",
          position: 0,
          catalog_settings: catalogSettings,
          merged_sources: [],
          source_label: null,
        },
      ]);
    });

    it.each([undefined, "", "   "])(
      "normalizes an empty RPDB key (%j) to null",
      async (rpdbApiKey) => {
        await postConfig(OWNER, {
          rpdbApiKey,
          lists: [{ sourceRef: OWNER, sortOption: "added_at-asc" }],
        });
        expect(rpcArgs().p_rpdb_api_key).toBeNull();
      },
    );

    it("deletes only the cache IDs returned by the committed transaction", async () => {
      cache.seed(UUID_1, []);
      cache.seed(UUID_2, []);
      rpcMocks.rpc.mockResolvedValueOnce({
        data: [{ deleted_ids: [UUID_2], lists: [savedRow] }],
        error: null,
      });
      const response = await postConfig(OWNER, {
        lists: [{ id: UUID_1, sourceRef: OWNER, sortOption: "title-asc" }],
      });
      expect(response.status).toBe(200);
      expect(cache.get(UUID_1)).not.toBeNull();
      expect(cache.get(UUID_2)).toBeNull();
    });

    it("keeps caches and skips prewarming when the RPC fails", async () => {
      cache.seed(UUID_2, []);
      rpcMocks.rpc.mockResolvedValueOnce({
        data: null,
        error: new Error("Transaction rolled back"),
      });
      const response = await postConfig(OWNER, {
        rpdbApiKey: "new-key",
        lists: [{ id: UUID_1, sourceRef: OWNER, sortOption: "title-asc" }],
      });
      expect(response.status).toBe(500);
      expect(cache.get(UUID_2)).not.toBeNull();
      expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
    });
  });

  // ---- in-memory transaction (mirrors replace_account_config) ----

  describe("saving through the transaction", () => {
    it("updates kept Lists, inserts new ones and deletes removed ones with their cache", async () => {
      seedWatchlist({ id: UUID_1, catalogTitle: "Old" });
      seedWatchlist({ id: UUID_2, sourceRef: OTHER_IMDB, position: 1 });
      cache.seed(UUID_2, []);

      const res = await postConfig(OWNER, {
        lists: [
          {
            id: UUID_1,
            sourceRef: OWNER,
            sortOption: "title-asc",
            catalogTitle: "New",
          },
          { sourceRef: "ls123456789", sortOption: "added_at-asc" },
        ],
      });

      expect(res.status).toBe(200);
      const rows = db.getTable("lists");
      expect(rows.map((row) => [row.source_ref, row.catalog_title])).toEqual([
        [OWNER, "New"],
        ["ls123456789", "2"],
      ]);
      expect(cache.get(UUID_2)).toBeNull();
    });

    it("rejects a List ID that belongs to another Account", async () => {
      const other = seedAccount();
      seedWatchlist({ id: UUID_2, accountId: other.id });

      const res = await postConfig(OWNER, {
        lists: [{ id: UUID_2, sourceRef: OWNER, sortOption: "added_at-asc" }],
      });

      expect(res.status).toBe(500);
      expect(db.getTable("lists")[0].account_id).toBe(other.id);
    });
  });
});

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

describe("POST /links/resolve", () => {
  function resolve(input: string, accountKey?: string) {
    return postJson("/links/resolve", { input, accountKey });
  }

  it("says when no Provider recognizes the input", async () => {
    const res = await resolve("not a link");
    expect(await res.json()).toEqual({ ok: false, reason: "unrecognized" });
  });

  it("says Letterboxd is coming soon", async () => {
    const res = await resolve("https://letterboxd.com/leo/watchlist/");
    expect(await res.json()).toEqual({
      ok: false,
      reason: "coming_soon",
      provider: "letterboxd",
    });
  });

  it("says when a Provider is turned off", async () => {
    const validateSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { validateSource }));
    process.env.DISABLED_PROVIDERS = "imdb, trakt";

    const res = await resolve("https://trakt.tv/users/leo/watchlist");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "disabled",
      provider: "trakt",
    });
    expect(validateSource).not.toHaveBeenCalled();
  });

  it("asks for a Connection when the list needs one", async () => {
    const res = await resolve("https://mdblist.com/lists/leo/top-movies");
    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
  });

  it("never uses a Connection for a Legacy alias", async () => {
    seedConnection(legacyAccountId, "mdblist");
    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      OWNER,
    );
    expect((await res.json()).reason).toBe("needs_connection");
  });

  it("asks for a Connection again when the Connection expired", async () => {
    const validateSource = vi.fn(
      async (
        _ref: string,
        ctx: { connection: { getAccessToken(): Promise<string> } | null },
      ) => {
        await ctx.connection?.getAccessToken();
        return { ok: true as const, ref: "lists/leo/top-movies" };
      },
    );
    useFakeProvider(fakeAdapter("mdblist", { validateSource }));
    const account = seedAccount();
    // Expired, and no refresh token to renew it.
    seedConnection(account.id, "mdblist", {
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: null,
    });

    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      account.id,
    );

    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
  });

  it("validates through the Connection of a private Account", async () => {
    const validateSource = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        ref: "lists/leo/top-movies",
        suggestedTitle: "Top movies",
      }),
    );
    useFakeProvider(fakeAdapter("mdblist", { validateSource }));
    const account = seedAccount();
    seedConnection(account.id, "mdblist", { username: "leo" });

    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      account.id,
    );

    expect(await res.json()).toEqual({
      ok: true,
      provider: "mdblist",
      sourceRef: "lists/leo/top-movies",
      kind: "list",
      requiresConnection: true,
      suggestedTitle: "Top movies",
      defaultDisplayMode: null,
    });
    expect(validateSource).toHaveBeenCalledWith("lists/leo/top-movies", {
      connection: expect.objectContaining({
        provider: "mdblist",
        username: "leo",
      }),
    });
  });

  it("resolves an IMDb watchlist link (p. handle) to its user ID", async () => {
    const validate = vi
      .spyOn(scraper, "validateImdbWatchlist")
      .mockResolvedValue({ valid: true, userId: OWNER });

    const res = await resolve("https://www.imdb.com/user/p.leo123/watchlist");

    expect(await res.json()).toEqual({
      ok: true,
      provider: "imdb",
      sourceRef: OWNER,
      kind: "watchlist",
      requiresConnection: false,
      suggestedTitle: null,
      defaultDisplayMode: null,
    });
    expect(validate).toHaveBeenCalledWith("p.leo123");
  });

  it("reports a private IMDb watchlist", async () => {
    vi.spyOn(scraper, "validateImdbWatchlist").mockResolvedValue({
      valid: false,
      reason: "private",
    });

    const res = await resolve(OWNER);

    expect(await res.json()).toEqual({
      ok: false,
      reason: "private",
      provider: "imdb",
    });
  });

  it("resolves an IMDb chart without a network call", async () => {
    const res = await resolve("imdb:top-rated-movies");

    expect(await res.json()).toMatchObject({
      ok: true,
      provider: "imdb",
      sourceRef: "imdb:top-rated-movies",
      kind: "chart",
      suggestedTitle: "Top 250 Movies",
      defaultDisplayMode: "movie",
    });
  });

  it("answers unavailable when validation throws", async () => {
    vi.spyOn(scraper, "validateImdbList").mockRejectedValue(
      new Error("socket hang up"),
    );

    const res = await resolve("https://www.imdb.com/list/ls123456789/");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "unavailable",
      provider: "imdb",
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

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

describe("GET /providers", () => {
  it("lists every Provider with its kill switch and OAuth status", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        oauth: {
          authorizeUrl: "https://trakt.example/oauth/authorize",
          tokenUrl: "https://trakt.example/oauth/token",
          clientId: () => "client-id",
        },
      }),
    );
    useFakeProvider(
      fakeAdapter("simkl", {
        oauth: {
          authorizeUrl: "https://simkl.example/oauth/authorize",
          tokenUrl: "https://simkl.example/oauth/token",
          clientId: () => undefined,
        },
      }),
    );
    process.env.DISABLED_PROVIDERS = "justwatch";

    const res = await app.request("/providers");
    const { providers } = (await res.json()) as {
      providers: { id: ProviderId; enabled: boolean; connectable: boolean }[];
    };

    expect(providers.map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect(byId.get("trakt")).toEqual({
      id: "trakt",
      enabled: true,
      connectable: true,
    });
    expect(byId.get("simkl")?.connectable).toBe(false);
    expect(byId.get("imdb")?.connectable).toBe(false);
    expect(byId.get("justwatch")?.enabled).toBe(false);
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
    r2Objects.set(`connections/${account.id}/trakt/membership.json`, "{}");

    const res = await app.request(`/${account.id}/connections/trakt`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(db.getTable("connections")).toEqual([]);
    // The private List's cache is gone; the public one stays.
    expect(cache.get(privateList.id)).toBeNull();
    expect(cache.get(publicList.id)).not.toBeNull();
    expect(
      r2Objects.has(`connections/${account.id}/trakt/membership.json`),
    ).toBe(false);
  });
});
