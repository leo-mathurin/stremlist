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

function env(name: string) {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

function clientId(provider: ProviderId) {
  return getProvider(provider).oauth?.clientId();
}

type ProbeRead = () => Promise<number>;

function sourceRead(provider: ProviderId, ref: string) {
  return async () => {
    const snapshot = await getProvider(provider).fetchSource(ref, {
      connection: null,
      forceRefresh: true,
    });
    return snapshot.entries.length;
  };
}

function serviceRead(url: string) {
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

type ProbeResult =
  | { provider: ProviderId; ok: true; entries: number }
  | {
      provider: ProviderId;
      ok: false;
      outage: boolean;
      unavailable: boolean;
      error: string;
    };

async function runProbe(provider: ProviderId, read: ProbeRead) {
  try {
    if (!(await mayReadProvider(provider)))
      throw new Error(`${provider} is unavailable (turned off or halted)`);
    const degraded = await providerDegradation(provider);
    if (degraded) throw new Error(degraded);
    return { provider, ok: true, entries: await read() } satisfies ProbeResult;
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`${provider} monitor check failed:`, error);
    const unavailable = !(await mayReadProvider(provider));
    return {
      provider,
      ok: false,
      outage: isOutageFailure(err),
      unavailable,
      error,
    } satisfies ProbeResult;
  }
}

async function recordOutage(
  provider: ProviderId,
  probe: ProbeResult | undefined,
  page: StatusPageState | null,
) {
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
  if (claimed) scheduleBackgroundTask(() => runListChecks(results));
  const statusPages = Object.fromEntries(
    checks
      .filter(({ provider }) => STATUS_PAGE_PROVIDERS.includes(provider))
      .map(({ provider, page }) => [provider, page]),
  );
  const ok = results.every((result) => result.ok || result.unavailable);
  const listChecks = { started: claimed, last: await lastListChecks() };
  return c.json({ ok, results, statusPages, listChecks }, ok ? 200 : 502);
});

export default monitor;
