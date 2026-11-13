import { zValidator } from "@hono/zod-validator";
import { ACCOUNT_ID_PATTERN } from "@stremlist/shared/constants";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { backendOrigin } from "../../lib/urls";
import {
  StremioSessionError,
  StremioUnavailableError,
} from "../../services/stremio";
import {
  StremioLinkTokenError,
  StremioNotLinkedError,
  disconnectStremio,
  installInStremio,
  linkWithToken,
  startStremioLink,
  updateStremio,
} from "../../services/stremio-link";
import { requireAccess } from "./access";

const accountParam = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
});
const linkBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9]{1,32}\.\d{1,16}\.[A-Za-z0-9_-]{43}$/),
});

/** Why a Stremio request failed, as the configure page names it. */
type StremioFailure = "signed-out" | "unavailable";

function failureBody(reason: StremioFailure) {
  return { reason };
}

function failure(c: Context, error: unknown) {
  // Not linked any more: the key was forgotten, as for a signed-out one.
  if (
    error instanceof StremioSessionError ||
    error instanceof StremioNotLinkedError
  ) {
    return c.json(failureBody("signed-out"), 409);
  }
  if (!(error instanceof StremioUnavailableError)) {
    console.error("Stremio update failed:", error);
  }
  return c.json(failureBody("unavailable"), 502);
}

function addonUrl(c: Context, accountId: string) {
  return `${backendOrigin(c)}/${accountId}/manifest.json`;
}

/**
 * The Stremio account linked to an Account (ADR 0002). Private Account IDs
 * only: the key can rewrite the member's Stremio addons.
 */
const stremio = new Hono()
  // A code for the member to confirm on Stremio's page.
  .post(
    "/:accountId/stremio/link",
    zValidator("param", accountParam),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      try {
        return c.json(await startStremioLink(accountId));
      } catch (error) {
        return failure(c, error);
      }
    },
  )

  // Asked every few seconds while the member confirms the code. The token
  // stays in the body: request logs keep URLs.
  .post(
    "/:accountId/stremio/link/confirm",
    zValidator("param", accountParam),
    zValidator("json", linkBody),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const { token } = c.req.valid("json");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      try {
        const link = await linkWithToken(accountId, token);
        return c.json({ stremio: link });
      } catch (error) {
        if (error instanceof StremioLinkTokenError) {
          return c.json({ reason: "expired" as const }, 410);
        }
        return failure(c, error);
      }
    },
  )

  .post(
    "/:accountId/stremio/update",
    zValidator("param", accountParam),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      try {
        return c.json({
          result: await updateStremio(accountId, addonUrl(c, accountId)),
        });
      } catch (error) {
        return failure(c, error);
      }
    },
  )

  // Only on the member's request: a removed Stremlist is never added back
  // by an update.
  .post(
    "/:accountId/stremio/install",
    zValidator("param", accountParam),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      try {
        await installInStremio(accountId, addonUrl(c, accountId));
        return c.json({ result: "updated" as const });
      } catch (error) {
        return failure(c, error);
      }
    },
  )

  .delete(
    "/:accountId/stremio",
    zValidator("param", accountParam),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      try {
        await disconnectStremio(accountId);
        return c.json({ ok: true as const });
      } catch (error) {
        console.error(
          `Failed to forget the Stremio link of ${accountId}:`,
          error,
        );
        return c.json({ error: "Could not disconnect Stremio." }, 500);
      }
    },
  );

export default stremio;
