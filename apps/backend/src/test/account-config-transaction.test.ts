/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { Tables } from "@stremlist/shared/database";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  legacyAccountId,
  OTHER_IMDB,
  OWNER,
  postConfig,
  resetConfigTest,
  rpcArgs,
  seedWatchlist,
  UUID_1,
  UUID_2,
} from "./helpers/config-api.js";
import { movie, seedAccount } from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import { cache } from "./helpers/list-cache.test-utils.js";
import { db, rpcCallsOf, rpcHandlers } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { rpcError } from "./helpers/supabase/rpc.js";

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();

beforeEach(() => {
  resetConfigTest();
  imdb.reset();
  server.use(imdb.handler, cinemetaWithoutTitles);
});

afterEach(async () => {
  await background.settle();
});

const SAVED_TITLE = movie("tt0000001", { name: "Saved title" });

describe("List CRUD via the config API", () => {
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
      imdb.watchlists.set(OWNER, [SAVED_TITLE]);
      imdb.titles.set(SAVED_TITLE.id, SAVED_TITLE);
      imdb.watchlists.set(OTHER_IMDB, [movie("tt0000002")]);
      rpcHandlers.set("replace_account_config", () => ({
        data: [
          {
            previous_lists: [{ ...savedRow, account_id: legacyAccountId }],
            lists: [{ ...savedRow, account_id: legacyAccountId }],
          },
        ],
        error: null,
      }));
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
      expect(rpcCallsOf("replace_account_config")).toEqual([
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
              catalog_title: "",
              sort_option: "year-desc",
              display_mode: "split",
              position: 1,
              merged_sources: [],
              source_label: null,
            },
          ],
          p_actions_enabled: null,
          p_action_providers: null,
          p_new_titles_catalog: null,
          p_poster_source: "rpdb",
        },
      ]);
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
        lists: expected.map((row) => ({
          ...row,
          availableGenres: [],
          sourceGenres: [null],
        })),
        newTitles: expect.objectContaining({ detected: 0 }) as unknown,
      });
      await background.settle();
      expect(
        rpcCallsOf("request_list_prewarm").map((args) => args.p_account_id),
      ).toEqual([legacyAccountId]);
      expect(
        imdb
          .requestsOf("WatchListPage")
          .map(({ variables }) => variables.urConst),
      ).toEqual([OWNER]);
      expect(cache.get(UUID_1)?.data.metas).toMatchObject([SAVED_TITLE]);
      expect(cache.get(UUID_2)).toBeNull();
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
          catalog_title: "",
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
          catalog_title: "",
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

    it("deletes only the caches that the committed transaction left unused", async () => {
      cache.seed(UUID_1, []);
      cache.seed(UUID_2, []);
      rpcHandlers.set("replace_account_config", () => ({
        data: [
          {
            previous_lists: [
              savedRow,
              {
                ...savedRow,
                id: UUID_2,
                source_ref: "ur99999999",
                position: 1,
              },
            ],
            lists: [savedRow],
          },
        ],
        error: null,
      }));
      const response = await postConfig(OWNER, {
        lists: [{ id: UUID_1, sourceRef: OWNER, sortOption: "title-asc" }],
      });
      expect(response.status).toBe(200);
      await background.settle();
      expect(cache.get(UUID_1)).not.toBeNull();
      expect(cache.get(UUID_2)).toBeNull();
    });

    it("keeps caches and skips prewarming when the RPC fails", async () => {
      cache.seed(UUID_2, []);
      rpcHandlers.set("replace_account_config", () =>
        rpcError("Transaction rolled back"),
      );
      const response = await postConfig(OWNER, {
        rpdbApiKey: "new-key",
        lists: [{ id: UUID_1, sourceRef: OWNER, sortOption: "title-asc" }],
      });
      expect(response.status).toBe(500);
      expect(cache.get(UUID_2)).not.toBeNull();
      expect(background.scheduled).toBe(0);
    });
  });

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
      await background.settle();
      const rows = db.getTable("lists");
      expect(rows.map((row) => [row.source_ref, row.catalog_title])).toEqual([
        [OWNER, "New"],
        ["ls123456789", ""],
      ]);
      expect(cache.get(UUID_2)).toBeNull();
    });

    it("drops the cache of a List that now reads another Source list", async () => {
      seedWatchlist({ id: UUID_1, sourceRef: "imdb:top-rated-movies" });
      seedWatchlist({ id: UUID_2, sourceRef: OTHER_IMDB, position: 1 });
      cache.seed(UUID_1, []);
      cache.seed(UUID_2, []);

      const res = await postConfig(OWNER, {
        lists: [
          {
            id: UUID_1,
            sourceRef: "imdb:most-popular-movies",
            sortOption: "added_at-asc",
          },
          {
            id: UUID_2,
            sourceRef: OTHER_IMDB,
            sortOption: "title-asc",
            catalogTitle: "Renamed",
          },
        ],
      });

      expect(res.status).toBe(200);
      await background.settle();
      expect(cache.get(UUID_1)).toBeNull();
      expect(cache.get(UUID_2)).not.toBeNull();
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
