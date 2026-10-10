/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

import * as scraper from "../services/imdb-scraper";
import {
  backgroundMocks,
  prewarmMocks,
  rpcMocks,
} from "./helpers/config-api-mocks.js";
import {
  getConfig,
  legacyAccountId,
  OTHER_IMDB,
  OWNER,
  postConfig,
  postJson,
  resetConfigTest,
  rpcArgs,
  runScheduledTasks,
  seedWatchlist,
  UUID_1,
  UUID_2,
} from "./helpers/config-api.js";
import { seedAccount, seedConnection } from "./helpers/fixtures.js";
import {
  fakeActions,
  fakeAdapter,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db } from "./helpers/mock-supabase.js";

beforeEach(resetConfigTest);

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
});
