import { zValidator } from "@hono/zod-validator";
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_KEY_PATTERN,
  DISPLAY_MODE_OPTIONS,
  IMDB_WATCHLIST_SOURCE_ID_PATTERN,
  SORT_OPTIONS,
  parseSortOption,
} from "@stremlist/shared/constants";
import { isChartId } from "@stremlist/shared/imdb-charts";
import type { ListSource } from "@stremlist/shared/list-merge";
import {
  MAX_SOURCES_PER_ACCOUNT,
  MAX_SOURCES_PER_LIST,
  listMergeProblem,
  sourceKey,
} from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  CONNECTION_SOURCES,
  PROVIDER_IDS,
  PROVIDERS,
  parseSourceLink,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type {
  AccountConfigResponse,
  AccountSyncSnapshot,
  AddonAccess,
  ConfigList,
} from "@stremlist/shared/stremio.types";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { scheduleBackgroundTask } from "../lib/background";
import { resend } from "../lib/resend";
import { supabase } from "../lib/supabase";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type { AccountAccess, ListInput } from "../services/accounts";
import {
  MergedSourcesChangedError,
  createAccount,
  createPrivateCopy,
  getAccountLists,
  getVisibleLists,
  replaceAccountConfig,
  resolveAccountKey,
} from "../services/accounts";
import { forgetConnectionObjects } from "../services/actions";
import { withAvailableGenres } from "../services/catalog-genres";
import { catalogSettingsSchema } from "../services/catalog-settings";
import {
  ConnectionExpiredError,
  deleteConnection,
  getConnectionAccess,
  listConnections,
} from "../services/connections";
import {
  forgetConnectionDetections,
  getNewTitlesSummary,
} from "../services/detections";
import {
  getImdbWatchlist,
  normalizeImdbUserId,
} from "../services/imdb-scraper";
import { previewList } from "../services/list-preview";
import { prewarmLists } from "../services/list-prewarm";
import { forgetConnectionLists, getListCatalog } from "../services/lists";
import {
  OAuthNotConfiguredError,
  isOAuthConfigured,
  startAuthorization,
} from "../services/oauth";
import { getListSyncStatuses } from "../services/sync-status";

const REFRESH_COOLDOWN_MS =
  (Number.isFinite(Number(process.env.REFRESH_COOLDOWN_SECONDS))
    ? Number(process.env.REFRESH_COOLDOWN_SECONDS)
    : 60) * 1000;

export const MAX_LISTS = 10;

const accountKeyParam = z.object({
  accountKey: z.string().regex(ACCOUNT_KEY_PATTERN),
});
const accountIdParam = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
});
const providerParam = z.enum(PROVIDER_IDS);

const sortOptionValues = SORT_OPTIONS.map((o) => o.value) as [
  string,
  ...string[],
];
const displayModeValues = DISPLAY_MODE_OPTIONS.map((o) => o.value) as [
  "split",
  ...("movie" | "series")[],
];

const listBody = z.object({
  id: z.string().uuid().optional(),
  provider: providerParam,
  sourceRef: z.string().trim().min(1).max(300),
  catalogTitle: z
    .string()
    .trim()
    .max(60, "Catalog titles must be 60 characters or fewer.")
    .optional(),
  sortOption: z.enum(sortOptionValues),
  displayMode: z.enum(displayModeValues).optional(),
  position: z.number().int().min(0).optional(),
  catalogSettings: catalogSettingsSchema.optional(),
  sourceLabel: z.string().trim().max(60).optional(),
  mergedSources: z
    .array(
      z.object({
        provider: providerParam,
        sourceRef: z.string().trim().min(1).max(300),
        label: z.string().trim().max(60).optional(),
      }),
    )
    .max(
      MAX_SOURCES_PER_LIST - 1,
      `A List can merge at most ${MAX_SOURCES_PER_LIST} Source lists.`,
    )
    .optional(),
});
const actionsBody = z.object({
  enabled: z.boolean(),
  providers: z.array(providerParam).max(PROVIDER_IDS.length),
});
const configBody = z.object({
  rpdbApiKey: z.string().trim().optional(),
  lists: z.array(listBody).min(1).max(MAX_LISTS),
  actions: actionsBody.optional(),
  newTitles: z.object({ enabled: z.boolean() }).optional(),
});

// A new Account may start without Lists: Simkl and MDBList users connect
// first (a Connection belongs to an Account), then pick their Source lists.
const createBody = configBody.extend({
  lists: z.array(listBody).max(MAX_LISTS),
});

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

type ListBody = z.infer<typeof listBody>;

class ConfigError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

function defaultTitle(index: number, total: number): string {
  return total <= 1 ? "" : String(index + 1);
}

/**
 * Check and normalize one Source list of a submitted List. IMDb `p.`
 * handles are turned into `ur…` IDs.
 */
async function normalizeSource(
  source: ListSource,
  access: { via: AddonAccess; connected: Set<ProviderId> },
): Promise<ListSource> {
  const info = PROVIDERS[source.provider];
  if (info.availability !== "available") {
    throw new ConfigError(`${info.label} is not available yet.`);
  }
  let sourceRef = source.sourceRef;
  if (source.provider === "imdb") {
    try {
      sourceRef = await normalizeImdbUserId(sourceRef);
    } catch {
      throw new ConfigError(
        `Could not resolve the IMDb handle "${source.sourceRef}". Please check it and try again.`,
      );
    }
    // The IMDb adapter treats any other ref as a watchlist user ID, so a
    // malformed one would be saved and fail on every catalog request.
    if (
      !IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(sourceRef) &&
      !isChartId(sourceRef)
    ) {
      throw new ConfigError(`"${source.sourceRef}" is not a valid IMDb list.`);
    }
  }
  if (sourceRequiresConnection(source.provider, sourceRef)) {
    if (access.via === "legacy") {
      throw new ConfigError(
        `${info.label} lists need your private Addon URL. Upgrade this install first.`,
      );
    }
    if (!access.connected.has(source.provider)) {
      throw new ConfigError(`Connect your ${info.label} account first.`);
    }
  }
  return { ...source, sourceRef };
}

/**
 * The Source lists of a submitted List, its first one first. An omitted
 * `mergedSources` or `sourceLabel` keeps the saved one, so older clients do
 * not split a merged List or erase its label; the transaction then checks
 * that the kept Source lists did not change since this read (`kept`).
 */
function submittedSources(
  list: ListBody,
  saved: ConfigList | undefined,
): { sources: ListSource[]; kept: boolean } {
  const sameFirst =
    saved?.provider === list.provider && saved.sourceRef === list.sourceRef;
  return {
    sources: [
      {
        provider: list.provider,
        sourceRef: list.sourceRef,
        label: list.sourceLabel ?? (sameFirst ? saved.sourceLabel : undefined),
      },
      ...(list.mergedSources ?? saved?.mergedSources ?? []),
    ],
    kept: !list.mergedSources && !!list.id,
  };
}

/**
 * Check and normalize submitted Lists. Light on purpose: links were already
 * resolved when the user added them, so saving does not read every Source
 * list again. Each Source list may be in only one List of the Account, and
 * merged Lists follow the rules of `listMergeProblem`.
 */
async function normalizeLists(
  lists: ListBody[],
  access: {
    via: AddonAccess;
    connected: Set<ProviderId>;
    /** Saved Lists, for the merged Source lists that a client omits. */
    saved: ConfigList[];
  },
): Promise<ListInput[]> {
  const normalized: ListInput[] = [];
  const seen = new Set<string>();
  const saved = new Map(access.saved.map((list) => [list.id, list]));
  for (const [index, list] of lists.entries()) {
    const submitted = submittedSources(
      list,
      list.id ? saved.get(list.id) : undefined,
    );
    const sources: ListSource[] = [];
    for (const source of submitted.sources) {
      const checked = await normalizeSource(source, access);
      if (seen.has(sourceKey(checked))) {
        throw new ConfigError("Each list can only be added once.");
      }
      seen.add(sourceKey(checked));
      sources.push(checked);
    }
    if (seen.size > MAX_SOURCES_PER_ACCOUNT) {
      throw new ConfigError(
        `You can have at most ${MAX_SOURCES_PER_ACCOUNT} Source lists in all your Lists.`,
      );
    }
    const [first, ...mergedSources] = sources;
    const input: ListInput = {
      id: list.id,
      provider: first.provider,
      sourceRef: first.sourceRef,
      catalogTitle:
        list.catalogTitle && list.catalogTitle.length > 0
          ? list.catalogTitle
          : defaultTitle(index, lists.length),
      sortOption: list.sortOption,
      displayMode: list.displayMode ?? "split",
      position: index,
      catalogSettings: list.catalogSettings,
      mergedSources,
      ...(first.label ? { sourceLabel: first.label } : {}),
      ...(submitted.kept ? { keptMergedSources: true } : {}),
    };
    const problem = listMergeProblem(input);
    if (problem) throw new ConfigError(problem);
    normalized.push(input);
  }
  return normalized;
}

async function connectedProviders(
  access: AccountAccess,
): Promise<Set<ProviderId>> {
  if (access.via !== "private") return new Set();
  return new Set(
    (await listConnections(access.account.id)).map((c) => c.provider),
  );
}

/** The sync status of these Lists and the Account's Connections. */
async function syncSnapshot(
  access: AccountAccess,
  lists: ConfigList[],
): Promise<AccountSyncSnapshot> {
  const [statuses, connections] = await Promise.all([
    getListSyncStatuses(lists),
    access.via === "private" ? listConnections(access.account.id) : [],
  ]);
  return { ...statuses, connections };
}

function requestOrigin(c: Context): string {
  return new URL(c.req.url).origin;
}

const api = new Hono()
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

  // What the configure page needs to know about each Provider right now.
  .get("/providers", (c) =>
    c.json({
      providers: PROVIDER_IDS.map((id) => ({
        id,
        enabled: isProviderEnabled(id),
        connectable: isOAuthConfigured(id),
      })),
    }),
  )

  // Detect the Provider behind a pasted link and check that it can be read.
  .post(
    "/links/resolve",
    zValidator(
      "json",
      z.object({
        input: z.string().trim().min(1).max(500),
        accountKey: z.string().regex(ACCOUNT_KEY_PATTERN).optional(),
      }),
    ),
    async (c) => {
      const { input, accountKey } = c.req.valid("json");
      const parsed = parseSourceLink(input);
      if (!parsed) {
        return c.json({ ok: false as const, reason: "unrecognized" as const });
      }
      const info = PROVIDERS[parsed.provider];
      if (info.availability !== "available") {
        return c.json({
          ok: false as const,
          reason: "coming_soon" as const,
          provider: parsed.provider,
        });
      }
      if (!isProviderEnabled(parsed.provider)) {
        return c.json({
          ok: false as const,
          reason: "disabled" as const,
          provider: parsed.provider,
        });
      }

      const access = accountKey ? await resolveAccountKey(accountKey) : null;
      const connection =
        access?.via === "private"
          ? await getConnectionAccess(access.account.id, parsed.provider)
          : null;
      if (parsed.requiresConnection && !connection) {
        return c.json({
          ok: false as const,
          reason: "needs_connection" as const,
          provider: parsed.provider,
        });
      }

      try {
        const result = await getProvider(parsed.provider).validateSource(
          parsed.ref,
          { connection },
        );
        if (!result.ok) {
          return c.json({
            ok: false as const,
            reason: result.reason,
            provider: parsed.provider,
          });
        }
        return c.json({
          ok: true as const,
          provider: parsed.provider,
          sourceRef: result.ref,
          kind: parsed.kind,
          requiresConnection: parsed.requiresConnection,
          suggestedTitle:
            result.suggestedTitle ?? parsed.suggestedTitle ?? null,
          defaultDisplayMode: result.defaultDisplayMode ?? null,
        });
      } catch (error) {
        if (error instanceof ConnectionExpiredError) {
          return c.json({
            ok: false as const,
            reason: "needs_connection" as const,
            provider: parsed.provider,
          });
        }
        console.error(
          `Validating ${parsed.provider} ${parsed.ref} failed:`,
          error instanceof Error ? error.message : error,
        );
        return c.json({
          ok: false as const,
          reason: "unavailable" as const,
          provider: parsed.provider,
        });
      }
    },
  )

  // Preview the Catalogs of a List, saved or not: a sample of Titles for each
  // Catalog and the Unresolved entries of its Source lists. Writes nothing.
  .post(
    "/lists/preview",
    zValidator(
      "json",
      listBody
        .pick({
          provider: true,
          sourceRef: true,
          mergedSources: true,
          sortOption: true,
          displayMode: true,
          catalogSettings: true,
        })
        .extend({ accountKey: accountKeyParam.shape.accountKey.optional() }),
    ),
    async (c) => {
      const { accountKey, ...list } = c.req.valid("json");
      // Like `/links/resolve`, an unknown key previews public lists only. A
      // Legacy alias can be guessed: it never reads through a Connection.
      const access = accountKey ? await resolveAccountKey(accountKey) : null;
      return c.json(
        await previewList({
          ...list,
          connectionAccountId:
            access?.via === "private" ? access.account.id : null,
        }),
      );
    },
  )

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
        const account = await createAccount();
        const saved = await replaceAccountConfig(
          account.id,
          normalized,
          rpdbApiKey && rpdbApiKey.length > 0 ? rpdbApiKey : null,
          { newTitlesCatalog: newTitles?.enabled },
        );
        scheduleBackgroundTask(() => prewarmLists(account.id, saved, true));
        return c.json({
          ok: true as const,
          accountId: account.id,
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
      const { accountKey } = c.req.valid("param");
      const access = await resolveAccountKey(accountKey);
      if (!access) {
        return c.json({ error: "Addon not found. Install it first." }, 404);
      }
      const { account } = access;
      const lists = await getVisibleLists(access);
      const [withGenres, sync, summary] = await Promise.all([
        withAvailableGenres(lists),
        syncSnapshot(access, lists),
        getNewTitlesSummary(access, lists),
      ]);
      const body: AccountConfigResponse = {
        access: access.via,
        accountId: access.via === "private" ? account.id : null,
        movedAt: account.movedAt,
        rpdbApiKey: account.rpdbApiKey,
        lists: withGenres,
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
      const { accountKey } = c.req.valid("param");
      const access = await resolveAccountKey(accountKey);
      if (!access) {
        return c.json({ error: "Addon not found. Install it first." }, 404);
      }
      return c.json(await syncSnapshot(access, await getVisibleLists(access)));
    },
  )

  .post(
    "/:accountKey/config",
    zValidator("param", accountKeyParam),
    zValidator("json", configBody, firstIssueAsError),
    async (c) => {
      const { accountKey } = c.req.valid("param");
      const { rpdbApiKey, lists, actions, newTitles } = c.req.valid("json");

      const access = await resolveAccountKey(accountKey);
      if (!access) {
        return c.json({ error: "Addon not found. Install it first." }, 404);
      }
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
          rpdbApiKey && rpdbApiKey.length > 0 ? rpdbApiKey : null,
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
      const { accountKey } = c.req.valid("param");
      const access = await resolveAccountKey(accountKey);
      if (!access) {
        return c.json({ error: "Addon not found. Install it first." }, 404);
      }
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

      const lists = await getVisibleLists(access);
      const refreshedAt = new Date().toISOString();
      const results = await Promise.allSettled(
        lists.map((list) =>
          getListCatalog({
            accountId: account.id,
            listId: list.id,
            provider: list.provider,
            sourceRef: list.sourceRef,
            mergedSources: list.mergedSources,
            sort: parseSortOption(list.sortOption),
            rpdbApiKey: account.rpdbApiKey,
            allowConnection: access.via === "private",
            forceFresh: true,
            skipAccountTimestamp: true,
            // A failed read must count as failed, not be masked by stale cache.
            noCacheFallback: true,
          }),
        ),
      );

      const refreshed = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - refreshed;

      if (refreshed > 0) {
        await supabase
          .from("accounts")
          .update({ last_fetched_at: refreshedAt })
          .eq("id", account.id);
      }

      const [withGenres, sync, summary] = await Promise.all([
        withAvailableGenres(lists),
        syncSnapshot(access, lists),
        getNewTitlesSummary(access, lists),
      ]);
      return c.json({
        ok: true,
        lastFetchedAt: refreshed > 0 ? refreshedAt : account.lastFetchedAt,
        refreshed,
        failed,
        total: lists.length,
        lists: withGenres,
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
      const access = await resolveAccountKey(accountKey);
      if (!access) {
        return c.json({ error: "Addon not found. Install it first." }, 404);
      }
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
  )

  .post(
    "/:accountId/connections/:provider/start",
    zValidator("param", accountIdParam.extend({ provider: providerParam })),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await resolveAccountKey(accountId);
      if (access?.via !== "private") {
        return c.json({ error: "Addon not found." }, 404);
      }
      if (!isProviderEnabled(provider)) {
        return c.json(
          { error: `${PROVIDERS[provider].label} is temporarily unavailable.` },
          503,
        );
      }
      try {
        const authorizeUrl = await startAuthorization(
          accountId,
          provider,
          requestOrigin(c),
        );
        return c.json({ ok: true as const, authorizeUrl });
      } catch (error) {
        if (error instanceof OAuthNotConfiguredError) {
          return c.json(
            { error: `${PROVIDERS[provider].label} cannot be connected yet.` },
            400,
          );
        }
        console.error(`Failed to start ${provider} authorization:`, error);
        return c.json({ error: "Could not start the connection." }, 500);
      }
    },
  )

  // Everything a Connection unlocks: static sources plus the user's own lists.
  .get(
    "/:accountId/connections/:provider/sources",
    zValidator("param", accountIdParam.extend({ provider: providerParam })),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await resolveAccountKey(accountId);
      if (access?.via !== "private") {
        return c.json({ error: "Addon not found." }, 404);
      }
      const staticSources = CONNECTION_SOURCES[provider] ?? [];
      // The kill switch also stops the call that lists the user's own lists.
      const connection = isProviderEnabled(provider)
        ? await getConnectionAccess(accountId, provider)
        : null;
      if (!connection) return c.json({ sources: staticSources });
      let own: typeof staticSources = [];
      try {
        own =
          (await getProvider(provider).listConnectionSources?.(connection)) ??
          [];
      } catch (error) {
        console.error(
          `Listing ${provider} sources for ${accountId} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      const seen = new Set(staticSources.map((source) => source.ref));
      return c.json({
        sources: [
          ...staticSources,
          ...own.filter((source) => !seen.has(source.ref)),
        ],
      });
    },
  )

  .delete(
    "/:accountId/connections/:provider",
    zValidator("param", accountIdParam.extend({ provider: providerParam })),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await resolveAccountKey(accountId);
      if (access?.via !== "private") {
        return c.json({ error: "Addon not found." }, 404);
      }
      await deleteConnection(accountId, provider);
      // Nothing read through the Connection stays served or stored.
      const cleanup = await Promise.allSettled([
        forgetConnectionLists(accountId, provider),
        forgetConnectionObjects(accountId, provider),
        forgetConnectionDetections(accountId, provider),
      ]);
      for (const outcome of cleanup) {
        if (outcome.status === "rejected") {
          console.error(
            `Cleaning up after the ${provider} disconnect of ${accountId} failed:`,
            outcome.reason,
          );
        }
      }
      return c.json({ ok: true as const });
    },
  )

  .post(
    "/newsletter/subscribe",
    zValidator("json", z.object({ email: z.string().email() })),
    async (c) => {
      const { email } = c.req.valid("json");

      if (!process.env.RESEND_API_KEY || !process.env.RESEND_AUDIENCE_ID) {
        return c.json(
          { success: false, error: "Newsletter service is not configured." },
          500,
        );
      }

      try {
        const contact = await resend.contacts.create({
          email,
          unsubscribed: false,
          audienceId: process.env.RESEND_AUDIENCE_ID,
        });
        // Resend returns provider failures as data rather than rejecting.
        if (contact.error) {
          throw Object.assign(new Error(contact.error.message), {
            statusCode: contact.error.statusCode,
          });
        }

        return c.json({
          success: true,
          message:
            "Successfully subscribed! You'll be notified about new features and updates.",
          contactId: contact.data.id,
        });
      } catch (err: unknown) {
        console.error(`Newsletter subscription error for ${email}:`, err);

        const message = err instanceof Error ? err.message : "";
        const statusCode =
          typeof err === "object" && err !== null && "statusCode" in err
            ? err.statusCode
            : null;

        if (
          message.includes("already exists") ||
          message.includes("duplicate")
        ) {
          return c.json({
            success: true,
            message:
              "You're already subscribed! You'll be notified about new features and updates.",
          });
        }

        if (statusCode === 422) {
          return c.json(
            { success: false, error: "Invalid email address format." },
            400,
          );
        }

        if (statusCode === 401) {
          console.error("Resend API authentication failed - check API key");
          return c.json(
            {
              success: false,
              error: "Newsletter service authentication failed.",
            },
            500,
          );
        }

        return c.json(
          {
            success: false,
            error: "Failed to subscribe. Please try again later.",
          },
          500,
        );
      }
    },
  )

  .get("/monitor", async (c) => {
    const authHeader = c.req.header("Authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const heartbeatUrl = process.env.BETTERSTACK_HEARTBEAT_URL;
    if (!heartbeatUrl) {
      return c.json({ error: "BETTERSTACK_HEARTBEAT_URL is not set" }, 500);
    }

    const testUserId = process.env.MONITOR_IMDB_USER_ID;
    if (!testUserId) {
      return c.json({ error: "MONITOR_IMDB_USER_ID is not set" }, 500);
    }

    try {
      const { items } = await getImdbWatchlist(testUserId);

      await fetch(heartbeatUrl);

      return c.json({ ok: true, items: items.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";

      await fetch(`${heartbeatUrl}/fail`, { method: "POST", body: message });

      console.error("IMDb monitor check failed:", message);
      return c.json({ ok: false, error: message }, 502);
    }
  });

export default api;
export type ApiRoutes = typeof api;
