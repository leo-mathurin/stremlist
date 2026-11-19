import { ACCOUNT_ID_PATTERN } from "@stremlist/shared/constants";
import { Hono } from "hono";
import { z } from "zod";
import { supabase } from "../lib/supabase";
import { timingSafeEqual } from "node:crypto";
import { scheduleBackgroundTask } from "../lib/background";
import { runWatchCron } from "../services/watch/cron";
import {
  onLibraryWatchedEvent,
  onPlayerEvent,
} from "../services/watch/trigger";

function isCron(header: string | undefined) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function extraOf(extra: string) {
  return new URLSearchParams(extra.replace(/\.json$/u, ""));
}

const TITLE_ID = /^tt\d+(?::\d+:\d+)?$/u;

/**
 * Watch tracking (ADR 0003): the cron run, and the events that Stremio Web
 * sends to addons with the `player` and `library` resources. Player cycles
 * and library additions are stored before the event is acknowledged.
 */
const watch = new Hono()
  .get("/watch/cron", async (c) => {
    if (!isCron(c.req.header("Authorization"))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const report = await runWatchCron();
    return c.json(report, report.ok ? 200 : 500);
  })

  .get("/:accountKey/player/:type/:id/:extra", async (c) => {
    c.header("Cache-Control", "no-store");
    const { accountKey, id, type, extra } = c.req.param();
    const fields = Object.fromEntries(extraOf(extra));
    const parsed = z
      .object({
        action: z.enum(["start", "pause", "stop"]),
        currentTime: z.coerce.number().finite().nonnegative().optional(),
        duration: z.coerce.number().finite().nonnegative().optional(),
      })
      .safeParse(fields);
    if (
      !ACCOUNT_ID_PATTERN.test(accountKey) ||
      !TITLE_ID.test(id) ||
      (type !== "movie" && type !== "series") ||
      !parsed.success ||
      (type === "movie" && id.includes(":"))
    )
      return c.json({ success: false }, 400);

    await onPlayerEvent(accountKey, id, type);
    return c.json({ success: true });
  })

  .get("/:accountKey/library/:type/:id/:extra", async (c) => {
    c.header("Cache-Control", "no-store");
    const { accountKey, id, type, extra } = c.req.param();
    const action = extraOf(extra).get("action");
    if (
      !ACCOUNT_ID_PATTERN.test(accountKey) ||
      !TITLE_ID.test(id) ||
      (type !== "movie" && type !== "series") ||
      !action ||
      !["libraryAdd", "libraryRemove", "watched", "unwatched"].includes(action)
    )
      return c.json({ success: false }, 400);
    if (action === "libraryAdd") {
      const { error } = await supabase.rpc("queue_library_addition", {
        p_account_id: accountKey,
        p_imdb_id: id.split(":")[0],
        p_type: type,
      });
      if (error) throw error;
    } else if (action === "watched") {
      scheduleBackgroundTask(() =>
        onLibraryWatchedEvent(accountKey, id.split(":")[0]),
      );
    }
    return c.json({ success: true });
  });

export default watch;
