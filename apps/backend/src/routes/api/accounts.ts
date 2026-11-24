import { zValidator } from "@hono/zod-validator";
import { parseSortOption } from "@stremlist/shared/constants";
import { defaultNewTitlesSettings } from "@stremlist/shared/manifest-catalogs";
import { DEFAULT_POSTER_SOURCE } from "@stremlist/shared/poster";
import type {
  AccountConfigResponse,
  ConfigList,
} from "@stremlist/shared/stremio.types";
import { Hono } from "hono";
import type { Context } from "hono";
import type { z } from "zod";
import { scheduleBackgroundTask } from "../../lib/background";
import { supabase } from "../../lib/supabase";
import { getProvider } from "../../providers/registry";
import {
  ConfigError,
  configBody,
  configSnapshot,
  connectedProviders,
  createBody,
  normalizeLists,
  rpdbKey,
  savedPosterSource,
  syncSnapshot,
} from "../../services/account-config";
import {
  MergedSourcesChangedError,
  createAccountWithConfig,
  getAccountLists,
  getVisibleLists,
  markAccountFetched,
  replaceAccountConfig,
} from "../../services/accounts";
import { withAvailableGenres } from "../../services/catalog-genres";
import { getNewTitlesSummary } from "../../services/detections";
import { prewarmLists } from "../../services/list-prewarm";
import { getListCatalog } from "../../services/lists";
import { getStremioLink } from "../../services/stremio-link";
import { accountKeyParam, requireAccess } from "./access";

const REFRESH_COOLDOWN_MS =
  (Number.isFinite(Number(process.env.REFRESH_COOLDOWN_SECONDS))
    ? Number(process.env.REFRESH_COOLDOWN_SECONDS)
    : 60) * 1000;

function firstIssueAsError(
  result: { success: true } | { success: false; error: z.core.$ZodError },
  c: Context,
) {
  if (!result.success) {
    return c.json({ error: result.error.issues[0].message }, 400);
  }
}

async function normalizeOrReject(
  c: Context,
  ...args: Parameters<typeof normalizeLists>
) {
  try {
    return await normalizeLists(...args);
  } catch (error) {
    if (error instanceof ConfigError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
}

/** Accounts: creation (and the legacy upgrade), configuration, refresh. */
const accounts = new Hono()
  .get("/stats", async (c) => {
    const { count, error } = await supabase
      .from("accounts")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true);

    if (error) {
      console.error("Failed to fetch account count:", error.message);
      return c.json({ activeUsers: 0 });
    }

    return c.json({ activeUsers: count ?? 0 });
  })

  .post(
    "/accounts",
    zValidator("json", createBody, firstIssueAsError),
    async (c) => {
      const body = c.req.valid("json");
      const { rpdbApiKey, lists, newTitles, catalogNamePrefix } = body;
      const posterSource = savedPosterSource(body);
      const fresh = lists.map((list) => ({ ...list, id: undefined }));
      const normalized = await normalizeOrReject(c, fresh, {
        via: "private",
        connected: new Set(),
        saved: [],
      });
      if (normalized instanceof Response) return normalized;

      try {
        const { accountId, lists: saved } = await createAccountWithConfig(
          normalized,
          rpdbKey(rpdbApiKey),
          { newTitles, posterSource, catalogNamePrefix },
        );
        scheduleBackgroundTask(() =>
          prewarmLists(accountId, saved, true, {
            posterSource: posterSource ?? DEFAULT_POSTER_SOURCE,
            rpdbApiKey: rpdbKey(rpdbApiKey),
          }),
        );
        return c.json({
          ok: true as const,
          accountId,
          lists: await withAvailableGenres(saved),
        });
      } catch (error) {
        console.error("Failed to create an account:", error);
        return c.json(
          {
            error: "Failed to save your configuration. Please try again later.",
          },
          500,
        );
      }
    },
  )

  .get(
    "/:accountKey/config",
    zValidator("param", accountKeyParam),
    async (c) => {
      const access = await requireAccess(c, c.req.valid("param").accountKey);
      if (access instanceof Response) return access;
      const { account } = access;
      const [{ lists, sync, summary }, stremio] = await Promise.all([
        getVisibleLists(access).then((visible) =>
          configSnapshot(access, visible),
        ),
        access.via === "private" ? getStremioLink(account.id) : null,
      ]);
      const body: AccountConfigResponse = {
        access: access.via,
        accountId: access.via === "private" ? account.id : null,
        rpdbApiKey: account.rpdbApiKey,
        posterSource: account.posterSource,
        catalogNamePrefix: account.catalogNamePrefix,
        lists,
        ...sync,
        actions: {
          enabled: account.actionsEnabled,
          providers: account.actionProviders,
        },
        newTitles: {
          enabled: account.newTitlesCatalog,
          summary,
          settings:
            account.newTitlesSettings ?? defaultNewTitlesSettings(lists),
        },
        lastFetchedAt: account.lastFetchedAt,
        cooldownSeconds: REFRESH_COOLDOWN_MS / 1000,
        stremio,
      };
      return c.json(body);
    },
  )

  .get(
    "/:accountKey/sync-status",
    zValidator("param", accountKeyParam),
    async (c) => {
      const access = await requireAccess(c, c.req.valid("param").accountKey);
      if (access instanceof Response) return access;
      return c.json(await syncSnapshot(access, await getVisibleLists(access)));
    },
  )

  .post(
    "/:accountKey/config",
    zValidator("param", accountKeyParam),
    zValidator("json", configBody, firstIssueAsError),
    async (c) => {
      const body = c.req.valid("json");
      const { rpdbApiKey, lists, actions, newTitles, catalogNamePrefix } = body;
      const posterSource = savedPosterSource(body);
      const access = await requireAccess(c, c.req.valid("param").accountKey);
      if (access instanceof Response) return access;
      if (access.via === "legacy" && actions?.enabled) {
        return c.json(
          {
            error:
              "Actions need your private Addon URL. Upgrade this install first.",
          },
          400,
        );
      }

      const [connected, savedLists] = await Promise.all([
        connectedProviders(access),
        getAccountLists(access.account.id),
      ]);
      const normalized = await normalizeOrReject(c, lists, {
        via: access.via,
        connected,
        saved: savedLists,
      });
      if (normalized instanceof Response) return normalized;

      let saved: ConfigList[];
      try {
        saved = await replaceAccountConfig(
          access.account.id,
          normalized,
          rpdbKey(rpdbApiKey),
          {
            actions:
              actions && access.via === "private"
                ? {
                    enabled: actions.enabled,
                    providers: [...new Set(actions.providers)].filter(
                      (provider) =>
                        connected.has(provider) &&
                        !!getProvider(provider).actions,
                    ),
                  }
                : undefined,
            newTitles,
            posterSource,
            catalogNamePrefix,
          },
        );
      } catch (error) {
        if (error instanceof MergedSourcesChangedError) {
          return c.json(
            {
              error:
                "Your lists changed in another window. Reload the page and try again.",
            },
            409,
          );
        }
        console.error("Failed to save the configuration:", error);
        return c.json(
          {
            error: "Failed to save your configuration. Please try again later.",
          },
          500,
        );
      }

      scheduleBackgroundTask(() =>
        prewarmLists(access.account.id, saved, access.via === "private", {
          posterSource: posterSource ?? access.account.posterSource,
          rpdbApiKey: rpdbKey(rpdbApiKey),
        }),
      );

      const [savedWithGenres, summary] = await Promise.all([
        withAvailableGenres(saved),
        getNewTitlesSummary(access, saved),
      ]);
      return c.json({
        ok: true as const,
        lists: savedWithGenres,
        newTitles: summary,
      });
    },
  )

  .post(
    "/:accountKey/refresh",
    zValidator("param", accountKeyParam),
    async (c) => {
      const access = await requireAccess(c, c.req.valid("param").accountKey);
      if (access instanceof Response) return access;
      const { account } = access;

      if (
        Date.now() - new Date(account.lastFetchedAt).getTime() <
        REFRESH_COOLDOWN_MS
      ) {
        return c.json({
          ok: true,
          lastFetchedAt: account.lastFetchedAt,
          refreshed: 0,
          failed: 0,
          total: 0,
          throttled: true,
          cooldownSeconds: REFRESH_COOLDOWN_MS / 1000,
        });
      }

      const visible = await getVisibleLists(access);
      const refreshedAt = new Date();
      const results = await Promise.allSettled(
        visible.map((list) =>
          getListCatalog(list, {
            accountId: account.id,
            sort: parseSortOption(list.sortOption),
            allowConnection: access.via === "private",
            policy: "manual",
          }),
        ),
      );

      const refreshed = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - refreshed;

      if (refreshed > 0) {
        await markAccountFetched(account.id, "last_fetched_at", refreshedAt);
      }

      const { lists, sync, summary } = await configSnapshot(access, visible);
      return c.json({
        ok: true,
        lastFetchedAt:
          refreshed > 0 ? refreshedAt.toISOString() : account.lastFetchedAt,
        refreshed,
        failed,
        total: visible.length,
        lists,
        ...sync,
        newTitles: summary,
        cooldownSeconds: REFRESH_COOLDOWN_MS / 1000,
      });
    },
  );

export default accounts;
