import { Hono } from "hono";
import { getImdbWatchlist } from "../../services/imdb-scraper";

/** The uptime check: reads one IMDb watchlist and reports to Better Stack. */
const monitor = new Hono().get("/monitor", async (c) => {
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

export default monitor;
