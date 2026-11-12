import { ACCOUNT_ID_PATTERN } from "@stremlist/shared/constants";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { scheduleBackgroundTask } from "../lib/background";
import { runWatchCron } from "../services/watch/cron";
import {
  onLibraryWatchedEvent,
  onPlayerEvent,
} from "../services/watch/trigger";

/** A Vercel Cron request carries `Authorization: Bearer $CRON_SECRET`. */
function isCron(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `action=pause&currentTime=…`, Stremio's extra segment, as a map. */
function extraOf(extra: string): URLSearchParams {
  return new URLSearchParams(extra.replace(/\.json$/u, ""));
}

const TITLE_ID = /^tt\d+(?::\d+:\d+)?$/u;

/**
 * Watch tracking (ADR 0003): the cron run, and the events that Stremio Web
 * sends to addons with the `player` and `library` resources. Events answer
 * at once: what they start runs in the background.
 */
const watch = new Hono()
  .get("/watch/cron", async (c) => {
    if (!isCron(c.req.header("Authorization"))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const report = await runWatchCron();
    return c.json(report, report.ok ? 200 : 500);
  })

  .get("/:accountKey/player/:type/:id/:extra", (c) => {
    const { accountKey, id } = c.req.param();
    const action = extraOf(c.req.param("extra")).get("action");
    if (
      ACCOUNT_ID_PATTERN.test(accountKey) &&
      TITLE_ID.test(id) &&
      (action === "pause" || action === "stop")
    ) {
      scheduleBackgroundTask(() => onPlayerEvent(accountKey, id));
    }
    return c.json({});
  })

  .get("/:accountKey/library/:type/:id/:extra", (c) => {
    const { accountKey, id } = c.req.param();
    const action = extraOf(c.req.param("extra")).get("action");
    if (
      ACCOUNT_ID_PATTERN.test(accountKey) &&
      TITLE_ID.test(id) &&
      action === "watched"
    ) {
      scheduleBackgroundTask(() =>
        onLibraryWatchedEvent(accountKey, id.split(":")[0]),
      );
    }
    return c.json({});
  });

export default watch;
