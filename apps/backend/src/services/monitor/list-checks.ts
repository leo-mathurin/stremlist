import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { isConnectionReset } from "../../lib/connection-reset";
import { supabase } from "../../lib/supabase";
import { z } from "zod";
import type { CanaryResult } from "./canaries";
import { canaryResultSchema, runCanaries } from "./canaries";
import type { ListAlarm } from "./list-alarm";
import { readListAlarms } from "./list-alarm";

const LIST_CHECK_INTERVAL_SECONDS = 600;
const RUN_NAME = "list-checks";

// WARNING: The monitor Account spends its owner's 1,000 MDBList requests a day.
const MDBLIST_CANARY_INTERVAL_SECONDS = 60 * 60;

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
  /** Whether every read of the Provider lost its connection to a reset. */
  lostToResets?: boolean;
}

function reportsOf(
  probes: readonly ProbeOutcome[],
  canaries: readonly CanaryResult[],
  alarms: readonly ListAlarm[],
) {
  const reset = (result: ProbeOutcome | CanaryResult) =>
    ("ok" in result ? !result.ok : result.status === "failed") &&
    "error" in result &&
    isConnectionReset(result.error);
  return PROVIDER_IDS.map((provider) => {
    const resets =
      probes.some((result) => result.provider === provider && reset(result)) ||
      canaries.some((result) => result.provider === provider && reset(result));
    const probe = probes.find(
      (result) => result.provider === provider && !reset(result),
    );
    const mine = canaries.filter(
      (result) => result.provider === provider && !reset(result),
    );
    const failures = [
      ...(probe && !probe.ok ? [`${provider} probe: ${probe.error}`] : []),
      ...mine.flatMap((result) =>
        result.status === "failed" && !result.pending
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
    return {
      provider,
      checked,
      failures,
      lostToResets: resets && !checked,
    } satisfies ProviderReport;
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
 * any more. So does a URL with no failure where one Provider lost every read
 * to a connection reset: the others' success must not hide it.
 */
export function heartbeatPings(
  reports: readonly ProviderReport[],
  urlOf: (provider: ProviderId) => string | undefined = heartbeatUrl,
) {
  const pings = new Map<
    string,
    HeartbeatPing & { checked: boolean; lost: boolean }
  >();
  for (const { provider, checked, failures, lostToResets } of reports) {
    const url = urlOf(provider);
    if (!url) continue;
    const ping = pings.get(url) ?? {
      url,
      failures: [],
      checked: false,
      lost: false,
    };
    ping.checked ||= checked;
    ping.lost ||= lostToResets ?? false;
    ping.failures.push(...failures);
    pings.set(url, ping);
  }
  return [...pings.values()]
    .filter((ping) => ping.failures.length > 0 || (ping.checked && !ping.lost))
    .map(({ url, failures }) => ({ url, failures }));
}

async function sendHeartbeat({ url, failures }: HeartbeatPing) {
  try {
    await (failures.length === 0
      ? fetch(url)
      : fetch(`${url}/fail`, { method: "POST", body: failures.join("\n") }));
  } catch {}
}

async function claimRun(name: string, intervalSeconds: number) {
  const { data, error } = await supabase.rpc("claim_monitor_run", {
    p_name: name,
    p_interval_seconds: intervalSeconds,
  });
  if (error) {
    console.error(`Could not claim the run ${name}:`, error.message);
    return false;
  }
  return data;
}

/**
 * Whether this call starts the list checks: only one call per interval
 * does. When the claim cannot be read, no call does: the heartbeats then
 * stop, and Better Stack alerts.
 */
export function claimListChecks() {
  return claimRun(RUN_NAME, LIST_CHECK_INTERVAL_SECONDS);
}

const previousCanariesSchema = z.object({
  canaries: z.array(canaryResultSchema),
});

async function canaryPlan() {
  const [due, last] = await Promise.all([
    claimRun(`${RUN_NAME}:mdblist`, MDBLIST_CANARY_INTERVAL_SECONDS),
    lastListChecks(),
  ]);
  const parsed = previousCanariesSchema.safeParse(last?.summary);
  const before = parsed.success ? parsed.data.canaries : [];
  const reused = due
    ? []
    : before.filter((result) => result.provider === "mdblist");
  return {
    read:
      reused.length === 0
        ? PROVIDER_IDS
        : PROVIDER_IDS.filter((provider) => provider !== "mdblist"),
    reused,
    before,
  };
}

function settle(
  read: readonly CanaryResult[],
  before: readonly CanaryResult[],
) {
  return read.map((result) =>
    result.status === "failed" &&
    result.transient &&
    !before.some(
      (previous) =>
        previous.status === "failed" &&
        !isConnectionReset(previous.error) &&
        previous.type === result.type &&
        previous.ref === result.ref,
    )
      ? { ...result, pending: true }
      : result,
  );
}

// WARNING: Keep this a type alias. An interface does not fit the Json column.
type ListCheckSummary = {
  canaries: CanaryResult[];
  alarms: ListAlarm[];
  alarmError?: string;
  failures: Partial<Record<ProviderId, string[]>>;
};

/**
 * Read the canaries and the alarm, then report each Provider to its
 * heartbeat with this call's probe. Canaries and the alarm never change a
 * Provider's outage state: only the probe does. A canary that fails for a
 * timeout, a server error or a network failure stays `pending` and alerts
 * only when its previous read failed too.
 */
export async function runListChecks(
  probes: readonly ProbeOutcome[],
  readCanaries = runCanaries,
) {
  const plan = await canaryPlan();
  const [read, alarmRead] = await Promise.all([
    readCanaries(plan.read),
    readListAlarms(),
  ]);
  const canaries = [...settle(read, plan.before), ...plan.reused];
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
