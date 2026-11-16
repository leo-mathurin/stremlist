import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { supabase } from "../lib/supabase";
import { HttpError } from "./http";
import { SourceBusyError, SourceUnavailableError } from "./types";

/**
 * Failed probes in a row before a Provider has an outage. One failure is
 * often a single slow request; two in a row are not.
 */
const OUTAGE_THRESHOLD = 2;

/**
 * An outage whose last conclusive probe is older than this is not shown:
 * when the monitor stops, the banner goes away instead of staying forever.
 */
export const OUTAGE_STALE_MS = 60 * 60_000;

/**
 * Whether a failed probe says that the Provider itself is down. Only server
 * errors, timeouts and network failures count, also when an adapter wraps
 * them in an "unavailable" SourceUnavailableError (as its `cause`). Rate limits,
 * a private or missing monitor list, a refused Connection, missing server
 * configuration and responses that Stremlist cannot parse do not: they are
 * Stremlist's problems or the monitor's, and the user must not read them as
 * a Provider outage.
 */
export function isOutageFailure(error: unknown): boolean {
  if (error instanceof SourceBusyError) return false;
  // "unavailable" alone also covers Stremlist's own failures (an unreadable
  // gate or cache, a page it cannot parse, a missing client ID).
  if (error instanceof SourceUnavailableError)
    return error.reason === "unavailable" && isOutageFailure(error.cause);
  if (error instanceof HttpError) return error.status >= 500;
  if (!(error instanceof Error)) return false;
  // AbortSignal.timeout() rejects with a TimeoutError. fetch() rejects with a
  // TypeError that carries a code (Bun: ECONNREFUSED, ENOTFOUND…) or a cause
  // (Node) when the connection fails; a TypeError without either is a bug.
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  return error instanceof TypeError && ("code" in error || "cause" in error);
}

/**
 * Record one conclusive probe. Never throws: a database failure must not
 * stop the other probes or their heartbeats.
 */
export async function recordProviderProbe(
  provider: ProviderId,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  try {
    const { error } = await supabase.rpc("record_provider_probe", {
      p_provider: provider,
      p_ok: result.ok,
      p_error: result.ok ? undefined : result.error,
      p_threshold: OUTAGE_THRESHOLD,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error(
      `Could not record the ${provider} probe:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.some((id) => id === value);
}

/**
 * When each Provider's current outage started, for the Providers that have
 * one. When the outages cannot be read, none is reported: the configure page
 * must never claim an outage that it cannot confirm.
 */
export async function currentProviderOutages(
  now = Date.now(),
): Promise<Partial<Record<ProviderId, string>>> {
  try {
    const { data, error } = await supabase
      .from("provider_outages")
      .select("provider, outage_since, checked_at")
      .not("outage_since", "is", null);
    if (error) throw new Error(error.message);
    const outages: Partial<Record<ProviderId, string>> = {};
    for (const row of data) {
      if (!row.outage_since || !isProviderId(row.provider)) continue;
      if (now - Date.parse(row.checked_at) > OUTAGE_STALE_MS) continue;
      outages[row.provider] = row.outage_since;
    }
    return outages;
  } catch (error) {
    console.error(
      "Could not read Provider outages:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}
