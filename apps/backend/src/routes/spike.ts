/**
 * SPIKE (spike/watch-tracking-load): load-test routes. Never merge.
 * Every route needs `Authorization: Bearer $CRON_SECRET`.
 */
import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { runWatchCron } from "../services/watch/run";

const spike = new Hono();

spike.use("/spike/*", async (c, next) => {
  const secret = process.env.CRON_SECRET;
  const given = c.req.header("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (
    !secret ||
    given.length !== expected.length ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

spike.post("/spike/watch/cron", async (c) => {
  const rate = Number(c.req.query("simklRate") ?? 0);
  const stats = await runWatchCron(rate);
  return c.json(stats);
});

/**
 * Every environment variable by name, with the host of URL values and a
 * short hash of each value: no value is shown.
 */
spike.get("/spike/env-audit", (c) => {
  const entries = Object.entries(process.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      const text = value ?? "";
      const hosts = [
        ...text.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^/?#\s:@]+(?::[0-9]+)?)/gi),
      ].map((match) => match[1]);
      return {
        name,
        length: text.length,
        sha8: createHash("sha256").update(text).digest("hex").slice(0, 8),
        hosts,
      };
    });
  return c.json(entries);
});

/** Round trips to a mock path, to tell network time from mock time. */
spike.get("/spike/ping", async (c) => {
  const url = process.env.SPIKE_PING_URL;
  if (!url) return c.json({ error: "no SPIKE_PING_URL" }, 400);
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const at = performance.now();
    await fetch(url).then((r) => r.text());
    times.push(Math.round(performance.now() - at));
  }
  return c.json({ times });
});

export default spike;
