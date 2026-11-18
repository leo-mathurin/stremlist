import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { supabase } from "../../lib/supabase";
import type { CanaryResult } from "./canaries";
import { runCanaries } from "./canaries";
import type { ListAlarm } from "./list-alarm";
import { readListAlarms } from "./list-alarm";

const LIST_CHECK_INTERVAL_SECONDS = 600;
const RUN_NAME = "list-checks";

function env(name: string) {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

function heartbeatUrl(provider: ProviderId) {
  return (
    env(`BETTERSTACK_HEARTBEAT_URL_${provider.toUpperCase()}`) ??
    (provider === "imdb" ? env("BETTERSTACK_HEARTBEAT_URL") : undefined)
  );
}

/** What the probe of a Provider found in this /monitor call. */
export type ProbeOutcome =
  | { provider: ProviderId; ok: true }
  | { provider: ProviderId; ok: false; error: string };

/** What a run found for one Provider. */
interface ProviderReport {
  provider: ProviderId;
  /** Whether a probe or a canary read the Provider. */
  checked: boolean;
  /** One line per failure, which names the probe or the list type. */
  failures: string[];
}

function reportsOf(
  probes: readonly ProbeOutcome[],
  canaries: readonly CanaryResult[],
  alarms: readonly ListAlarm[],
) {
  return PROVIDER_IDS.map((provider) => {
    const probe = probes.find((result) => result.provider === provider);
    const mine = canaries.filter((result) => result.provider === provider);
    const failures = [
      ...(probe && !probe.ok ? [`${provider} probe: ${probe.error}`] : []),
      ...mine.flatMap((result) =>
        result.status === "failed"
          ? [`${result.type} (${result.ref}): ${result.error}`]
          : [],
      ),
      ...alarms
        .filter((alarm) => alarm.provider === provider)
        .map(
          (alarm) =>
            `${alarm.type}: ${alarm.failing} of ${alarm.total} Lists fail as unavailable`,
        ),
    ];
    const checked =
      probe !== undefined ||
      mine.some(
        (result) => result.status === "ok" || result.status === "failed",
      );
    return { provider, checked, failures };
  });
}

/** One heartbeat request: success when `failures` is empty. */
export interface HeartbeatPing {
  url: string;
  failures: string[];
}

/**
 * One ping per heartbeat URL, for the Providers that share it: it fails
 * when one of them failed. A URL whose Providers nothing checked and
 * nothing failed gets no ping, so Better Stack alerts when no check runs
 * any more.
 */
export function heartbeatPings(
  reports: readonly ProviderReport[],
  urlOf: (provider: ProviderId) => string | undefined = heartbeatUrl,
) {
  const pings = new Map<string, HeartbeatPing & { checked: boolean }>();
  for (const { provider, checked, failures } of reports) {
    const url = urlOf(provider);
    if (!url) continue;
    const ping = pings.get(url) ?? { url, failures: [], checked: false };
    ping.checked ||= checked;
    ping.failures.push(...failures);
    pings.set(url, ping);
  }
  return [...pings.values()]
    .filter((ping) => ping.checked || ping.failures.length > 0)
    .map(({ url, failures }) => ({ url, failures }));
}

async function sendHeartbeat({ url, failures }: HeartbeatPing) {
  try {
    await (failures.length === 0
      ? fetch(url)
      : fetch(`${url}/fail`, { method: "POST", body: failures.join("\n") }));
  } catch {}
}

/**
 * Whether this call starts the list checks: only one call per interval
 * does. When the claim cannot be read, no call does: the heartbeats then
 * stop, and Better Stack alerts.
 */
export async function claimListChecks() {
  const { data, error } = await supabase.rpc("claim_monitor_run", {
    p_name: RUN_NAME,
    p_interval_seconds: LIST_CHECK_INTERVAL_SECONDS,
  });
  if (error) {
    console.error("Could not claim the list checks:", error.message);
    return false;
  }
  return data;
}

/** A type, not an interface, so that it fits the Json column. */
export type ListCheckSummary = {
  canaries: CanaryResult[];
  alarms: ListAlarm[];
  /** Why the sync statuses could not be read for the alarm, if they could not. */
  alarmError?: string;
  /** The failures that the run reported, per Provider. */
  failures: Partial<Record<ProviderId, string[]>>;
};

/**
 * Read the canaries and the alarm, then report each Provider to its
 * heartbeat with this call's probe. Canaries and the alarm never change a
 * Provider's outage state: only the probe does.
 */
export async function runListChecks(probes: readonly ProbeOutcome[]) {
  const [canaries, alarmRead] = await Promise.all([
    runCanaries(),
    readListAlarms(),
  ]);
  const alarms = "alarms" in alarmRead ? alarmRead.alarms : [];
  const reports = reportsOf(probes, canaries, alarms);
  await Promise.all(heartbeatPings(reports).map(sendHeartbeat));
  const summary: ListCheckSummary = {
    canaries,
    alarms,
    ...("error" in alarmRead ? { alarmError: alarmRead.error } : {}),
    failures: Object.fromEntries(
      reports
        .filter((report) => report.failures.length > 0)
        .map((report) => [report.provider, report.failures]),
    ),
  };
  const { error } = await supabase
    .from("monitor_runs")
    .update({
      finished_at: new Date().toISOString(),
      summary,
    })
    .eq("name", RUN_NAME);
  if (error) console.error("Could not save the list checks:", error.message);
  return summary;
}

/** The last run of the list checks that completed, or null. */
export async function lastListChecks() {
  const { data, error } = await supabase
    .from("monitor_runs")
    .select("started_at, finished_at, summary")
    .eq("name", RUN_NAME)
    .maybeSingle();
  if (error || !data) return null;
  return {
    startedAt: data.started_at,
    finishedAt: data.finished_at,
    summary: data.summary,
  };
}
