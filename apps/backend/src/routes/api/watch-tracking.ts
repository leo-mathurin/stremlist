import { zValidator } from "@hono/zod-validator";
import { ACCOUNT_ID_PATTERN } from "@stremlist/shared/constants";
import { WATCH_PROVIDERS } from "@stremlist/shared/watch-tracking";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { backendOrigin } from "../../lib/urls";
import type { UpdateResult } from "../../services/stremio";
import {
  StremioSessionError,
  StremioUnavailableError,
} from "../../services/stremio";
import {
  StremioNotLinkedError,
  updateStremio,
} from "../../services/stremio-link";
import {
  getWatchTracking,
  setWatchDestinations,
  WatchDestinationError,
  WatchNeedsStremioError,
} from "../../services/watch/tracking";
import { requireAccess } from "./access";

const accountParam = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
});
const destinationsBody = z.object({
  destinations: z.array(z.enum(WATCH_PROVIDERS)).max(WATCH_PROVIDERS.length),
});

/** What happened to the installed Stremlist after the change. */
type StremioUpdate = UpdateResult | "signed-out" | "unavailable";

async function updateInstalled(
  c: Context,
  accountId: string,
): Promise<StremioUpdate> {
  try {
    return await updateStremio(
      accountId,
      `${backendOrigin(c)}/${accountId}/manifest.json`,
    );
  } catch (error) {
    if (
      error instanceof StremioSessionError ||
      error instanceof StremioNotLinkedError
    ) {
      return "signed-out";
    }
    if (!(error instanceof StremioUnavailableError)) {
      console.error("Stremio update after Watch tracking failed:", error);
    }
    return "unavailable";
  }
}

/**
 * Watch tracking of an Account (ADR 0003). Private Account IDs only: it
 * reads the member's Stremio library and writes to their Connections.
 */
const watchTracking = new Hono()
  .get(
    "/:accountId/watch-tracking",
    zValidator("param", accountParam),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      return c.json(await getWatchTracking(accountId));
    },
  )

  // Replaces the Destinations. Stremio's installed Stremlist is updated in
  // the same request: it must declare the resources that carry the trigger.
  .put(
    "/:accountId/watch-tracking",
    zValidator("param", accountParam),
    zValidator("json", destinationsBody),
    async (c) => {
      const { accountId } = c.req.valid("param");
      const { destinations } = c.req.valid("json");
      const access = await requireAccess(c, accountId, { privateOnly: true });
      if (access instanceof Response) return access;
      try {
        await setWatchDestinations(accountId, destinations);
      } catch (error) {
        if (error instanceof WatchNeedsStremioError) {
          return c.json({ reason: "stremio-not-linked" as const }, 409);
        }
        if (error instanceof WatchDestinationError) {
          return c.json({ reason: "not-connected" as const }, 400);
        }
        if (error instanceof StremioSessionError) {
          return c.json({ reason: "signed-out" as const }, 409);
        }
        if (!(error instanceof StremioUnavailableError)) {
          console.error("Failed to change Watch tracking:", error);
        }
        return c.json({ reason: "unavailable" as const }, 502);
      }
      const stremio = await updateInstalled(c, accountId);
      return c.json({ status: await getWatchTracking(accountId), stremio });
    },
  );

export default watchTracking;
