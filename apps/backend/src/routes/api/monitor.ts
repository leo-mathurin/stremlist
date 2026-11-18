import type { ProviderId } from "@stremlist/shared/providers";
import { Hono } from "hono";
import {
  mayReadProvider,
  providerDegradation,
} from "../../providers/availability";
import { HttpError, providerFetch } from "../../providers/http";
import { isOutageFailure, recordProviderProbe } from "../../providers/outages";
import { getProvider, isProviderEnabled } from "../../providers/registry";
import type { StatusPageState } from "../../providers/status-pages";
import {
  readStatusPage,
  STATUS_PAGE_PROVIDERS,
} from "../../providers/status-pages";
import { SIMKL_API } from "../../providers/simkl/api";
import { scheduleBackgroundTask } from "../../lib/background";
import {
  claimListChecks,
  lastListChecks,
  runListChecks,
} from "../../services/monitor/list-checks";

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
 * the configure page shows) and its Better Stack heartbeat, which the list
 * checks send (services/monitor/list-checks.ts).
 */
const PROBES: {
  provider: ProviderId;
  read: () => ProbeRead | undefined;
}[] = [
  {
    provider: "imdb",
    read: () => {
      const ref = env("MONITOR_IMDB_USER_ID");
      return ref ? sourceRead("imdb", ref) : undefined;
    },
  },
  {
    provider: "letterboxd",
    read: () =>
      sourceRead(
        "letterboxd",
        env("MONITOR_LETTERBOXD_REF") ??
          "users/official/lists/letterboxds-top-500-films",
      ),
  },
  {
    provider: "justwatch",
    read: () => {
      const ref = env("MONITOR_JUSTWATCH_REF");
      return ref ? sourceRead("justwatch", ref) : undefined;
    },
  },
  {
    provider: "senscritique",
    read: () => {
      const ref = env("MONITOR_SENSCRITIQUE_REF");
      return ref ? sourceRead("senscritique", ref) : undefined;
    },
  },
  {
    // Trakt's public charts need only the app's client ID.
    provider: "trakt",
    read: () =>
      clientId("trakt")
        ? sourceRead("trakt", env("MONITOR_TRAKT_REF") ?? "trending")
        : undefined,
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
  },
  {
    provider: "mdblist",
    read: () =>
      clientId("mdblist")
        ? serviceRead("https://api.mdblist.com/lists/top")
        : undefined,
  },
];

/**
 * A failed probe. `outage` says whether the failure counts toward an outage
 * of the Provider (see isOutageFailure); other failures still alert.
 * `unavailable` says that the Provider is turned off or halted: its heartbeat
 * alerts, but the answer of /monitor does not fail.
 */
type ProbeResult =
  | { provider: ProviderId; ok: true; entries: number }
  | {
      provider: ProviderId;
      ok: false;
      outage: boolean;
      unavailable: boolean;
      error: string;
    };

async function runProbe(
  provider: ProviderId,
  read: ProbeRead,
): Promise<ProbeResult> {
  try {
    // An unavailable Provider (turned off, or halted with no probe due) is
    // never contacted. Its Availability already tells the user.
    if (!(await mayReadProvider(provider)))
      throw new Error(`${provider} is unavailable (turned off or halted)`);
    const degraded = await providerDegradation(provider);
    if (degraded) throw new Error(degraded);
    return { provider, ok: true, entries: await read() };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`${provider} monitor check failed:`, error);
    // Checked after the read: a halt can start during it.
    const unavailable = !(await mayReadProvider(provider));
    return {
      provider,
      ok: false,
      outage: isOutageFailure(err),
      unavailable,
      error,
    };
  }
}

/**
 * Record what this run learned about a Provider's outage. The Provider's own
 * status page saying "down" starts an outage at once. Otherwise a working
 * probe, then a probe that failed because of the Provider, then the status
 * page saying "up" decide. With none of them, nothing changes.
 */
async function recordOutage(
  provider: ProviderId,
  probe: ProbeResult | undefined,
  page: StatusPageState | null,
): Promise<void> {
  if (page === "down")
    return recordProviderProbe(provider, {
      ok: false,
      error: `The ${provider} status page reports an outage`,
      immediate: true,
    });
  if (probe?.ok) return recordProviderProbe(provider, { ok: true });
  if (probe?.outage)
    return recordProviderProbe(provider, { ok: false, error: probe.error });
  if (page === "up") return recordProviderProbe(provider, { ok: true });
}

/**
 * The uptime check: probes each Provider, reads the official status pages
 * and records outages for the configure page. At most once in 10 minutes,
 * one call also starts the list checks after its answer: they report each
 * Provider to Better Stack. The answer gives the last run of the list
 * checks.
 */
const monitor = new Hono().get("/monitor", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Independent probes: one failure never skips the others. A turned-off
  // Provider's status page is not read: its label already says it all.
  const [checks, claimed] = await Promise.all([
    Promise.all(
      PROBES.map(async ({ provider, read: readOf }) => {
        const read = readOf();
        const [probe, page] = await Promise.all([
          read ? runProbe(provider, read) : undefined,
          STATUS_PAGE_PROVIDERS.includes(provider) &&
          isProviderEnabled(provider)
            ? readStatusPage(provider)
            : null,
        ]);
        await recordOutage(provider, probe, page);
        return { provider, probe, page };
      }),
    ),
    claimListChecks(),
  ]);
  const results = checks.flatMap(({ probe }) => (probe ? [probe] : []));
  // The list checks take longer than Better Stack waits for an answer.
  if (claimed) scheduleBackgroundTask(() => runListChecks(results));
  const statusPages = Object.fromEntries(
    checks
      .filter(({ provider }) => STATUS_PAGE_PROVIDERS.includes(provider))
      .map(({ provider, page }) => [provider, page]),
  );
  // Only the probes fail the answer: a status page is an extra signal, and
  // the list checks alert through the heartbeats after the answer. A turned-off
  // or halted Provider alerts only through its heartbeat, so a Letterboxd halt
  // is one alert, not two.
  const ok = results.every((result) => result.ok || result.unavailable);
  const listChecks = { started: claimed, last: await lastListChecks() };
  return c.json({ ok, results, statusPages, listChecks }, ok ? 200 : 502);
});

export default monitor;
