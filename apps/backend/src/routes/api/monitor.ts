import type { ProviderId } from "@stremlist/shared/providers";
import { Hono } from "hono";
import {
  mayReadProvider,
  providerDegradation,
} from "../../providers/availability";
import { HttpError, providerFetch } from "../../providers/http";
import { isOutageFailure, recordProviderProbe } from "../../providers/outages";
import { getProvider } from "../../providers/registry";
import { SIMKL_API } from "../../providers/simkl/api";

/** An environment variable, with an empty value read as unset. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

/** The client ID of the Provider's app, or undefined when it has none. */
function clientId(provider: ProviderId): string | undefined {
  return getProvider(provider).oauth?.clientId();
}

/** A probe's read: the number of entries it found. */
type ProbeRead = () => Promise<number>;

/** Read a public Source list through the Provider's adapter. */
function sourceRead(provider: ProviderId, ref: string): ProbeRead {
  return async () => {
    // forceRefresh reads the Provider itself, never a cached page.
    const snapshot = await getProvider(provider).fetchSource(ref, {
      connection: null,
      forceRefresh: true,
    });
    return snapshot.entries.length;
  };
}

/**
 * Check that a Provider's API answers, for Providers whose lists all need a
 * Connection. Any answer below 500 (a 401 or 404 included) means that the
 * service is up; a 429 is a rate limit, not an outage.
 */
function serviceRead(url: string): ProbeRead {
  return async () => {
    const response = await providerFetch(url, {
      retryOn429: false,
      timeoutMs: 10_000,
    });
    if (response.status >= 500 || response.status === 429) {
      throw new HttpError(
        response.status,
        await response.text().catch(() => ""),
        url,
      );
    }
    return 0;
  };
}

/**
 * One probe per Provider. A probe runs when Stremlist knows what to read:
 * a public Source list for Providers read without a Connection, the API
 * itself for the others. Its result feeds the Provider's outage state (what
 * the configure page shows) and, when set, its own Better Stack heartbeat,
 * so an alert names the Provider that broke.
 */
const PROBES: {
  provider: ProviderId;
  read: () => ProbeRead | undefined;
  heartbeat: () => string | undefined;
}[] = [
  {
    provider: "imdb",
    read: () => {
      const ref = env("MONITOR_IMDB_USER_ID");
      return ref ? sourceRead("imdb", ref) : undefined;
    },
    // BETTERSTACK_HEARTBEAT_URL is the original IMDb heartbeat.
    heartbeat: () =>
      env("BETTERSTACK_HEARTBEAT_URL_IMDB") ?? env("BETTERSTACK_HEARTBEAT_URL"),
  },
  {
    provider: "letterboxd",
    read: () =>
      sourceRead(
        "letterboxd",
        env("MONITOR_LETTERBOXD_REF") ??
          "users/official/lists/letterboxds-top-500-films",
      ),
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD"),
  },
  {
    provider: "justwatch",
    read: () => {
      const ref = env("MONITOR_JUSTWATCH_REF");
      return ref ? sourceRead("justwatch", ref) : undefined;
    },
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_JUSTWATCH"),
  },
  {
    provider: "senscritique",
    read: () => {
      const ref = env("MONITOR_SENSCRITIQUE_REF");
      return ref ? sourceRead("senscritique", ref) : undefined;
    },
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_SENSCRITIQUE"),
  },
  {
    // Trakt's public charts need only the app's client ID.
    provider: "trakt",
    read: () =>
      clientId("trakt")
        ? sourceRead("trakt", env("MONITOR_TRAKT_REF") ?? "trending")
        : undefined,
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_TRAKT"),
  },
  {
    provider: "simkl",
    read: () => {
      const id = clientId("simkl");
      if (!id) return undefined;
      const url = new URL("/search/id", SIMKL_API);
      url.searchParams.set("imdb", "tt0111161");
      url.searchParams.set("client_id", id);
      return serviceRead(url.toString());
    },
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_SIMKL"),
  },
  {
    provider: "mdblist",
    read: () =>
      clientId("mdblist")
        ? serviceRead("https://api.mdblist.com/lists/top")
        : undefined,
    heartbeat: () => env("BETTERSTACK_HEARTBEAT_URL_MDBLIST"),
  },
];

/**
 * A failed probe. `outage` says whether the failure counts toward an outage
 * of the Provider (see isOutageFailure); other failures still alert.
 */
type ProbeResult =
  | { provider: ProviderId; ok: true; entries: number }
  | { provider: ProviderId; ok: false; outage: boolean; error: string };

async function runProbe(
  provider: ProviderId,
  read: ProbeRead,
  heartbeat: string | undefined,
): Promise<ProbeResult> {
  let result: ProbeResult;
  try {
    // An unavailable Provider (turned off, or halted with no probe due) is
    // never contacted. Its Availability already tells the user.
    if (!(await mayReadProvider(provider)))
      throw new Error(`${provider} is unavailable (turned off or halted)`);
    const degraded = await providerDegradation(provider);
    if (degraded) throw new Error(degraded);
    result = { provider, ok: true, entries: await read() };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`${provider} monitor check failed:`, error);
    result = { provider, ok: false, outage: isOutageFailure(err), error };
  }

  // Only conclusive probes change the outage state.
  if (result.ok) await recordProviderProbe(provider, { ok: true });
  else if (result.outage)
    await recordProviderProbe(provider, { ok: false, error: result.error });

  if (heartbeat) {
    try {
      await (result.ok
        ? fetch(heartbeat)
        : fetch(`${heartbeat}/fail`, { method: "POST", body: result.error }));
    } catch {
      /* Better Stack also alerts when the heartbeat stops arriving. */
    }
  }
  return result;
}

/**
 * The uptime check: probes each Provider, records outages for the configure
 * page, and reports to Better Stack.
 */
const monitor = new Hono().get("/monitor", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Independent probes: one failure never skips the others.
  const results = await Promise.all(
    PROBES.flatMap((probe) => {
      const read = probe.read();
      return read ? [runProbe(probe.provider, read, probe.heartbeat())] : [];
    }),
  );
  const ok = results.every((result) => result.ok);
  return c.json({ ok, results }, ok ? 200 : 502);
});

export default monitor;
