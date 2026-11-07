import type { ProviderId } from "@stremlist/shared/providers";
import { Hono } from "hono";
import { isProviderAvailable } from "../../providers/availability";
import { getProvider } from "../../providers/registry";

/** An environment variable, with an empty value read as unset. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

/**
 * One anonymous probe per Provider that Stremlist reads without a Connection.
 * Each one reads a fixed public Source list and reports to its own Better Stack
 * heartbeat, so an alert names the Provider that broke. A probe runs only when
 * both its reference and its heartbeat URL are set.
 */
const PROBES: {
  provider: ProviderId;
  ref: () => string | undefined;
  heartbeat: () => string | undefined;
}[] = [
  {
    provider: "imdb",
    ref: () => env("MONITOR_IMDB_USER_ID"),
    // BETTERSTACK_HEARTBEAT_URL is the original IMDb heartbeat.
    heartbeat: () =>
      env("BETTERSTACK_HEARTBEAT_URL_IMDB") ?? env("BETTERSTACK_HEARTBEAT_URL"),
  },
  {
    provider: "letterboxd",
    ref: () => env("MONITOR_LETTERBOXD_REF") ?? "films/popular/this/week",
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD"),
  },
  {
    provider: "justwatch",
    ref: () => env("MONITOR_JUSTWATCH_REF"),
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_JUSTWATCH"),
  },
  {
    provider: "senscritique",
    ref: () => env("MONITOR_SENSCRITIQUE_REF"),
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_SENSCRITIQUE"),
  },
];

type ProbeResult =
  | { provider: ProviderId; ok: true; entries: number }
  | { provider: ProviderId; ok: false; error: string };

async function runProbe(
  provider: ProviderId,
  ref: string,
  heartbeat: string,
): Promise<ProbeResult> {
  try {
    // An unavailable Provider (turned off or halted) is never contacted.
    if (!(await isProviderAvailable(provider)))
      throw new Error(`${provider} is unavailable (turned off or halted)`);
    // forceRefresh reads the Provider itself, never a cached page.
    const snapshot = await getProvider(provider).fetchSource(ref, {
      connection: null,
      forceRefresh: true,
    });
    await fetch(heartbeat);
    return { provider, ok: true, entries: snapshot.entries.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`${provider} monitor check failed:`, message);
    try {
      await fetch(`${heartbeat}/fail`, { method: "POST", body: message });
    } catch {
      /* Better Stack also alerts when the heartbeat stops arriving. */
    }
    return { provider, ok: false, error: message };
  }
}

/** The uptime check: probes each configured Provider and reports to Better Stack. */
const monitor = new Hono().get("/monitor", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const configured = PROBES.flatMap((probe) => {
    const ref = probe.ref();
    const heartbeat = probe.heartbeat();
    return ref && heartbeat
      ? [{ provider: probe.provider, ref, heartbeat }]
      : [];
  });
  if (configured.length === 0) {
    return c.json({ error: "No Provider monitor is configured" }, 500);
  }

  // Independent probes: one failure never skips the others.
  const results = await Promise.all(
    configured.map(({ provider, ref, heartbeat }) =>
      runProbe(provider, ref, heartbeat),
    ),
  );
  const ok = results.every((result) => result.ok);
  return c.json({ ok, results }, ok ? 200 : 502);
});

export default monitor;
