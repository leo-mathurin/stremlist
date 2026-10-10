import { zValidator } from "@hono/zod-validator";
import { PROVIDER_IDS, PROVIDERS } from "@stremlist/shared/providers";
import { Hono } from "hono";
import { backendOrigin } from "../../lib/urls";
import { isProviderEnabled } from "../../providers/registry";
import { connectionSources } from "../../services/connections";
import { disconnectProvider } from "../../services/lists";
import {
  OAuthNotConfiguredError,
  isOAuthConfigured,
  startAuthorization,
} from "../../services/oauth";
import { connectionParam, requireAccess } from "./access";

/** Providers and the Connections of an Account. */
const connections = new Hono()
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

  .post(
    "/:accountId/connections/:provider/start",
    zValidator("param", connectionParam),
    async (c) => {
      const { accountId, provider } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
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
          backendOrigin(c),
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
      // Nothing read through the Connection stays served or stored.
      await disconnectProvider(accountId, provider);
      return c.json({ ok: true as const });
    },
  );

export default connections;
