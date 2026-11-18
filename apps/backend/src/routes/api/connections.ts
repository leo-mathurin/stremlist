import { zValidator } from "@hono/zod-validator";
import { DEFAULT_POSTER_SOURCE } from "@stremlist/shared/poster";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS, PROVIDERS } from "@stremlist/shared/providers";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { scheduleBackgroundTask } from "../../lib/background";
import { backendOrigin } from "../../lib/urls";
import { isProviderAvailable } from "../../providers/availability";
import { currentProviderOutages } from "../../providers/outages";
import { getProvider, isProviderEnabled } from "../../providers/registry";
import {
  ConfigError,
  createBody,
  normalizeLists,
  providerParam,
  rpdbKey,
  savedPosterSource,
} from "../../services/account-config";
import {
  createAccountWithConfig,
  deleteAccount,
} from "../../services/accounts";
import { resetConnectionCaches } from "../../services/actions";
import { connectionSources, saveConnection } from "../../services/connections";
import { prewarmLists } from "../../services/list-prewarm";
import {
  disconnectProvider,
  rereadConnectionLists,
} from "../../services/lists";
import {
  OAuthNotConfiguredError,
  consumeState,
  exchangeCode,
  isOAuthConfigured,
  redirectUri,
  startAuthorization,
} from "../../services/oauth";
import { connectionParam, requireAccess } from "./access";

const providerOnlyParam = z.object({ provider: providerParam });

const completeBody = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(2000),
  browserKey: z.string().min(1).max(200),
  setup: createBody.optional(),
});

type CompleteFailure = "expired" | "unavailable" | "failed";

function completeFailure(
  c: Context,
  reason: CompleteFailure,
  status: 400 | 502 | 503,
) {
  return c.json({ error: `Connection ${reason}.`, reason }, status);
}

async function startFor(
  c: Context,
  accountId: string | null,
  provider: ProviderId,
) {
  if (!(await isProviderAvailable(provider))) {
    return c.json(
      { error: `${PROVIDERS[provider].label} is temporarily unavailable.` },
      503,
    );
  }
  try {
    const { authorizeUrl, browserKey } = await startAuthorization(
      accountId,
      provider,
      backendOrigin(c),
    );
    return c.json({ ok: true as const, authorizeUrl, browserKey });
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
}

/** Providers and the Connections of an Account. */
const connections = new Hono()
  .get("/providers", async (c) => {
    const outages = await currentProviderOutages();
    return c.json({
      providers: await Promise.all(
        PROVIDER_IDS.map(async (id) => {
          const enabled = await isProviderAvailable(id);
          return {
            id,
            enabled,
            connectable: isOAuthConfigured(id),
            outageSince: enabled ? (outages[id] ?? null) : null,
          };
        }),
      ),
    });
  })

  .post(
    "/:accountId/connections/:provider/start",
    zValidator("param", connectionParam),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      return startFor(c, accountId, provider);
    },
  )

  .post(
    "/connections/:provider/start",
    zValidator("param", providerOnlyParam),
    (c) => startFor(c, null, c.req.valid("param").provider),
  )

  .post(
    "/connections/:provider/complete",
    zValidator("param", providerOnlyParam),
    zValidator("json", completeBody),
    async (c) => {
      const { provider } = c.req.valid("param");
      const { state, code, browserKey, setup } = c.req.valid("json");
      const pending = await consumeState(provider, state, browserKey);
      if (!pending) return completeFailure(c, "expired", 400);
      if (!isProviderEnabled(provider)) {
        return completeFailure(c, "unavailable", 503);
      }

      let newSetup: Awaited<ReturnType<typeof normalizeLists>> | null = null;
      if (!pending.accountId) {
        try {
          newSetup = await normalizeLists(
            (setup?.lists ?? []).map((list) => ({ ...list, id: undefined })),
            { via: "private", connected: new Set(), saved: [] },
          );
        } catch (error) {
          if (error instanceof ConfigError) {
            return c.json({ error: error.message, reason: "failed" }, 400);
          }
          throw error;
        }
      }

      const redirect = redirectUri(provider, backendOrigin(c));
      let accountId = pending.accountId;
      try {
        const tokens = await exchangeCode(
          provider,
          code,
          pending.codeVerifier,
          redirect,
        );
        let username: string | null = null;
        try {
          username =
            (await getProvider(provider).oauth?.fetchUsername?.(
              tokens.accessToken,
            )) ?? null;
        } catch (usernameError) {
          console.error(
            `Fetching the ${provider} username failed:`,
            usernameError instanceof Error
              ? usernameError.message
              : usernameError,
          );
        }
        if (newSetup) {
          const created = await createAccountWithConfig(
            newSetup,
            rpdbKey(setup?.rpdbApiKey),
            {
              newTitlesCatalog: setup?.newTitles?.enabled,
              posterSource: setup && savedPosterSource(setup),
            },
          );
          accountId = created.accountId;
          try {
            await saveConnection(
              accountId,
              provider,
              tokens,
              username,
              redirect,
            );
          } catch (saveError) {
            await deleteAccount(accountId);
            throw saveError;
          }
          const createdId = accountId;
          scheduleBackgroundTask(() =>
            prewarmLists(createdId, created.lists, true, {
              posterSource:
                (setup && savedPosterSource(setup)) ?? DEFAULT_POSTER_SOURCE,
              rpdbApiKey: rpdbKey(setup?.rpdbApiKey),
            }),
          );
          return c.json({ ok: true as const, accountId, created: true });
        }
        if (!accountId) throw new Error("No Account for the authorization");
        await saveConnection(accountId, provider, tokens, username, redirect);
      } catch (exchangeError) {
        console.error(
          `Completing the ${provider} connection failed:`,
          exchangeError instanceof Error
            ? exchangeError.message
            : exchangeError,
        );
        return completeFailure(c, "failed", 502);
      }

      const connectedId = accountId;
      scheduleBackgroundTask(async () => {
        try {
          await resetConnectionCaches(connectedId, provider);
        } catch (forgetError) {
          console.error(
            `Forgetting the previous ${provider} connection state failed:`,
            forgetError instanceof Error ? forgetError.message : forgetError,
          );
        }
        await rereadConnectionLists(connectedId, provider);
      });
      return c.json({ ok: true as const, accountId, created: false });
    },
  )

  .get(
    "/:accountId/connections/:provider/sources",
    zValidator("param", connectionParam),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      return c.json({ sources: await connectionSources(accountId, provider) });
    },
  )

  .delete(
    "/:accountId/connections/:provider",
    zValidator("param", connectionParam),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      await disconnectProvider(accountId, provider);
      return c.json({ ok: true as const });
    },
  );

export default connections;
