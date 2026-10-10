import { zValidator } from "@hono/zod-validator";
import { parseSortOption } from "@stremlist/shared/constants";
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
  syncSnapshot,
} from "../../services/account-config";
import type { ListInput } from "../../services/accounts";
import {
  MergedSourcesChangedError,
  createAccountWithConfig,
  createPrivateCopy,
  getAccountLists,
  getVisibleLists,
  markAccountFetched,
  replaceAccountConfig,
} from "../../services/accounts";
import { withAvailableGenres } from "../../services/catalog-genres";
import { getNewTitlesSummary } from "../../services/detections";
import { prewarmLists } from "../../services/list-prewarm";
import { getListCatalog } from "../../services/lists";
import { accountKeyParam, requireAccess } from "./access";

const REFRESH_COOLDOWN_MS =
  (Number.isFinite(Number(process.env.REFRESH_COOLDOWN_SECONDS))
    ? Number(process.env.REFRESH_COOLDOWN_SECONDS)
    : 60) * 1000;

// Report the first schema problem with the same `{ error }` string as other
// configuration failures, not as a raw Zod issue object.
function firstIssueAsError(
  result: { success: true } | { success: false; error: z.ZodError },
  c: Context,
) {
  if (!result.success) {
    return c.json({ error: result.error.issues[0].message }, 400);
  }
}

/** Accounts: creation, configuration, refresh and upgrade. */
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

  // Create an Account with its first Lists. Returns the private Account ID.
  .post(
    "/accounts",
    zValidator("json", createBody, firstIssueAsError),
    async (c) => {
      const { rpdbApiKey, lists, newTitles } = c.req.valid("json");
      let normalized: ListInput[];
      try {
        normalized = await normalizeLists(lists, {
          via: "private",
          connected: new Set(),
          saved: [],
        });
      } catch (error) {
        if (error instanceof ConfigError) {
          return c.json({ error: error.message }, error.status);
        }
        throw error;
      }

      try {
        const { accountId, lists: saved } = await createAccountWithConfig(
          normalized,
          rpdbKey(rpdbApiKey),
          { newTitlesCatalog: newTitles?.enabled },
        );
        scheduleBackgroundTask(() => prewarmLists(accountId, saved, true));
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
      const { lists, sync, summary } = await configSnapshot(
        access,
        await getVisibleLists(access),
      );
      const body: AccountConfigResponse = {
        access: access.via,
        accountId: access.via === "private" ? account.id : null,
        movedAt: account.movedAt,
        rpdbApiKey: account.rpdbApiKey,
        lists,
        ...sync,
        actions: {
          enabled: account.actionsEnabled,
          providers: account.actionProviders,
        },
        newTitles: { enabled: account.newTitlesCatalog, summary },
        lastFetchedAt: account.lastFetchedAt,
        cooldownSeconds: REFRESH_COOLDOWN_MS / 1000,
      };
      return c.json(body);
    },
  )

  // The sync status of every List and Connection, polled by the configure
  // page while a refresh it started is still running.
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
      const { rpdbApiKey, lists, actions, newTitles } = c.req.valid("json");
      const access = await requireAccess(c, c.req.valid("param").accountKey);
      if (access instanceof Response) return access;
      if (access.via === "legacy" && access.account.movedAt) {
        return c.json(
          {
            error:
              "This install has a private Addon URL now. Open the configure page from your new install.",
            moved: true,
          },
          409,
        );
      }
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
      let normalized: ListInput[];
      try {
        normalized = await normalizeLists(lists, {
          via: access.via,
          connected,
          saved: savedLists,
        });
      } catch (error) {
        if (error instanceof ConfigError) {
          return c.json({ error: error.message }, error.status);
        }
        throw error;
      }

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
            newTitlesCatalog: newTitles?.enabled,
          },
        );
      } catch (error) {
        if (error instanceof MergedSourcesChangedError) {
          return c.json(
            {
              error:
                "Your Lists changed in another window. Reload the page and try again.",
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

      // Queue every saved List; the cache-first path skips warm entries.
      scheduleBackgroundTask(() =>
        prewarmLists(access.account.id, saved, access.via === "private"),
      );

      // The saved Lists change what the summary counts.
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

      // Server-side cooldown protects Providers from rapid manual refreshes.
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
          // A failed read counts as failed, not masked by a stale cache.
          getListCatalog(list, {
            accountId: account.id,
            sort: parseSortOption(list.sortOption),
            rpdbApiKey: account.rpdbApiKey,
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
  )

  // Give a Legacy alias install a private Addon URL (a copy, see ADR 0001).
  .post(
    "/:accountKey/upgrade",
    zValidator("param", accountKeyParam),
    async (c) => {
      const { accountKey } = c.req.valid("param");
      const access = await requireAccess(c, accountKey);
      if (access instanceof Response) return access;
      if (access.via !== "legacy") {
        return c.json(
          { error: "This install already has a private URL." },
          400,
        );
      }
      try {
        const account = await createPrivateCopy(access.account);
        const lists = await getAccountLists(account.id);
        scheduleBackgroundTask(() => prewarmLists(account.id, lists, true));
        return c.json({ ok: true as const, accountId: account.id });
      } catch (error) {
        console.error(`Failed to upgrade ${accountKey}:`, error);
        return c.json(
          {
            error: "Failed to create your private URL. Please try again later.",
          },
          500,
        );
      }
    },
  );

export default accounts;
