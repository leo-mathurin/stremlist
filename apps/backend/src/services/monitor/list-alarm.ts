import type { ProviderId } from "@stremlist/shared/providers";
import {
  isProviderId,
  listTypeOf,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import { supabase } from "../../lib/supabase";

const ALARM_MIN_FAILING = 3;
const ALARM_MIN_FAILING_IN_SHARE = 2;
const ALARM_MIN_SHARE = 0.5;
/**
 * Only Source lists refreshed in this time count: a List that nobody reads
 * any more keeps its last failure forever.
 */
export const ALARM_ACTIVE_MS = 24 * 60 * 60_000;

const PAGE_SIZE = 1000;

/** The sync status of one Source list of one List. */
export interface StatusRow {
  provider: string;
  source_ref: string;
  failure_reason: string | null;
  last_attempt_at: string;
}

/** A list type whose Lists fail because of Stremlist or its Provider. */
export type ListAlarm = {
  type: string;
  provider: ProviderId;
  /** Source lists of the type that fail as "unavailable". */
  failing: number;
  /** Source lists of the type that were refreshed recently. */
  total: number;
};

/**
 * The list types to alarm on. Only "unavailable" is a failure of Stremlist
 * or of the Provider: the other reasons (private, not found, a lost
 * Connection…) are the user's, and never alarm. One or two failing Source
 * lists are often one broken list, so the rule asks for more. A public
 * Source list in several Lists counts once, with its last refresh; one read
 * through a Connection is the Account's own, so it counts for each List.
 */
export function listAlarms(rows: readonly StatusRow[]) {
  const sources = new Map<string, StatusRow>();
  for (const [index, row] of rows.entries()) {
    const key =
      isProviderId(row.provider) &&
      sourceRequiresConnection(row.provider, row.source_ref)
        ? `row:${index}`
        : `${row.provider}:${row.source_ref}`;
    const kept = sources.get(key);
    if (!kept || row.last_attempt_at > kept.last_attempt_at)
      sources.set(key, row);
  }
  const byType = new Map<string, ListAlarm>();
  for (const row of sources.values()) {
    if (!isProviderId(row.provider)) continue;
    const type = listTypeOf(row.provider, row.source_ref);
    const counts = byType.get(type) ?? {
      type,
      provider: row.provider,
      failing: 0,
      total: 0,
    };
    counts.total += 1;
    if (row.failure_reason === "unavailable") counts.failing += 1;
    byType.set(type, counts);
  }
  return [...byType.values()].filter(
    ({ failing, total }) =>
      failing >= ALARM_MIN_FAILING ||
      (failing >= ALARM_MIN_FAILING_IN_SHARE &&
        failing >= total * ALARM_MIN_SHARE),
  );
}

async function recentStatusRows(now: number) {
  const since = new Date(now - ALARM_ACTIVE_MS).toISOString();
  const rows: StatusRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("list_sync_status")
      .select("provider, source_ref, failure_reason, last_attempt_at")
      .gte("last_attempt_at", since)
      .order("list_id")
      .order("provider")
      .order("source_ref")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

type ListAlarmRead = { alarms: ListAlarm[] } | { error: string };

/** The list types to alarm on now, or the reason they cannot be read. */
export async function readListAlarms(now = Date.now()) {
  try {
    const read: ListAlarmRead = {
      alarms: listAlarms(await recentStatusRows(now)),
    };
    return read;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Could not read the sync statuses for the alarm:", message);
    const read: ListAlarmRead = { error: message };
    return read;
  }
}
